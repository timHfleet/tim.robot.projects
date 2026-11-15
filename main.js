// Hero robot arm + Jenga tower.
//
// The arm is a 3-link planar arm that reaches for the cursor with the same
// analytic inverse kinematics as my simulator: pick a tool angle, back off the
// last link to find the wrist, then solve the 2-link triangle with the law of
// cosines. Joints move like servos (rate-limited), so the arm glides.
//
// The blocks are real 2D rigid bodies (matter-js): gravity, friction, stacking
// and toppling. Hold the mouse on a block and the arm reaches for it and
// pinches it; drag to carry it; let go and it drops (keeping its momentum).
// The gripper itself is a solid body too, so it can knock the tower over.
// Show IK draws the geometry the solver uses; a score counts blocks moved before it falls.
(() => {
  const canvas = document.getElementById('arm')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const status = document.getElementById('arm-status')
  const resetBtn = document.getElementById('arm-reset')
  const M = window.Matter // physics (optional: the arm still works without it)

  let W = 0, H = 0, dpr = 1, scale = 1
  const L = [0.34, 0.3, 0.12] // link lengths (m), like the simulator
  const base = { x: 0, y: 0 } // shoulder, in CSS pixels
  let groundY = 0 // table top, in CSS pixels
  let q = [1.9, -1.7, -1.4] // shoulder, elbow, wrist (rad, relative)
  let grip = 1 // 1 open, 0 closed
  let pointer = null // last pointer position, in metres
  let lastMove = -1e9

  // --- physics state ----------------------------------------------------------
  let engine = null
  let blocks = [] // { body, w, h, end, startY }
  let gripperBody = null
  let reaching = null // { body, local } while the arm goes for a block
  let held = null // { body, offset, angle0 } while carrying
  let pressed = false
  let fallAnnounced = false
  let showIK = false
  let moved = 0 // blocks moved this round
  let best = 0
  try { best = +localStorage.getItem('jengaBest') || 0 } catch { /* storage blocked */ }
  let qVel = [0, 0, 0] // joint speeds, for the status LEDs
  const ikBtn = document.getElementById('arm-ik')
  const scoreEl = document.getElementById('arm-score')
  const updateScore = () => { if (scoreEl) scoreEl.textContent = `Moved ${moved} · Best ${best}` }
  const CAT_BLOCK = 0x0001
  const CAT_GRIPPER = 0x0002
  const CAT_WORLD = 0x0004

  function resize() {
    const r = canvas.getBoundingClientRect()
    if (r.width < 10) return // hidden behind the Fold-Off tab; the tab switch resizes it again
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    W = r.width
    H = r.height
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    scale = Math.min(W / 1.7, H / 0.95) // pixels per metre
    base.x = W * 0.42
    base.y = H * 0.84
    groundY = base.y + 20
    buildWorld()
  }

  const toWorld = (px, py) => ({ x: (px - base.x) / scale, y: (base.y - py) / scale })
  const toPx = (p) => ({ x: base.x + p.x * scale, y: base.y - p.y * scale })

  // --- physics world: table, walls and a Jenga tower ---------------------------
  function buildWorld() {
    if (!M) return
    engine = M.Engine.create({ enableSleeping: true, positionIterations: 10, velocityIterations: 8 })
    engine.gravity.y = 1
    const world = engine.world
    const wallOpts = { isStatic: true, friction: 0.9, collisionFilter: { category: CAT_WORLD } }
    M.Composite.add(world, [
      M.Bodies.rectangle(W / 2, groundY + 30, W * 3, 60, wallOpts),
      M.Bodies.rectangle(-30, H / 2, 60, H * 3, wallOpts),
      M.Bodies.rectangle(W + 30, H / 2, 60, H * 3, wallOpts),
    ])

    // Jenga in side view: layers alternate between one block seen along its
    // length and three blocks seen end-on.
    blocks = []
    const len = 0.17 * scale
    const thick = 0.034 * scale
    const gap = 0.004 * scale
    const endW = (len - 2 * gap) / 3
    const cx = base.x + 0.52 * scale
    const layers = 8
    for (let i = 0; i < layers; i++) {
      const y = groundY - thick / 2 - i * thick
      const parts = i % 2 === 0
        ? [{ x: cx, w: len, end: false }]
        : [-1, 0, 1].map((k) => ({ x: cx + k * (endW + gap), w: endW, end: true }))
      for (const p of parts) {
        const body = M.Bodies.rectangle(p.x, y, p.w, thick, {
          friction: 0.65,
          frictionStatic: 0.9,
          restitution: 0.02,
          density: 0.0018,
          slop: 0.02,
          collisionFilter: { category: CAT_BLOCK, mask: CAT_BLOCK | CAT_GRIPPER | CAT_WORLD },
        })
        M.Sleeping.set(body, true) // the tower starts at rest
        blocks.push({ body, w: p.w, h: thick, end: p.end, startY: y })
      }
    }
    M.Composite.add(world, blocks.map((b) => b.body))

    // The gripper: a solid little body at the tool point that pushes blocks.
    gripperBody = M.Bodies.circle(-100, -100, 0.02 * scale, {
      frictionAir: 0,
      friction: 0.3,
      collisionFilter: { category: CAT_GRIPPER, mask: CAT_BLOCK },
    })
    M.Body.setInertia(gripperBody, Infinity)
    M.Body.setMass(gripperBody, 50)
    gripperBody.sleepThreshold = Infinity // always awake, so it wakes and pushes what it touches
    M.Composite.add(world, gripperBody)

    reaching = null
    held = null
    fallAnnounced = false
    moved = 0
    updateScore()
    setStatus('Hold the mouse on a block to pick it up.')
  }

  function setStatus(text) {
    if (status) status.textContent = text
  }

  // --- inverse kinematics --------------------------------------------------------
  function ik(t, phi) {
    const wx = t.x - L[2] * Math.cos(phi)
    const wy = t.y - L[2] * Math.sin(phi)
    const c = (wx * wx + wy * wy - L[0] * L[0] - L[1] * L[1]) / (2 * L[0] * L[1])
    if (c > 1 || c < -1) return null
    const q2 = -Math.acos(c) // elbow up
    const q1 = Math.atan2(wy, wx) - Math.atan2(L[1] * Math.sin(q2), L[0] + L[1] * Math.cos(q2))
    return [q1, q2, phi - q1 - q2]
  }

  // Reach the point: try tool angles closest to pointing down first, then wider.
  function solve(t) {
    const maxR = L[0] + L[1] + L[2] - 0.005
    const r = Math.hypot(t.x, t.y)
    if (r > maxR) t = { x: (t.x / r) * maxR, y: (t.y / r) * maxR }
    const floor = (base.y - groundY) / scale + 0.012
    if (t.y < floor) t = { x: t.x, y: floor }
    const down = -Math.PI / 2
    for (let k = 0; k <= 36; k++) {
      for (const s of [1, -1]) {
        const sol = ik(t, k === 36 ? Math.atan2(t.y, t.x) : down + s * k * (Math.PI / 36))
        if (sol) return sol
      }
    }
    return null
  }

  function fk(qq) {
    let a = 0, x = 0, y = 0
    const pts = [{ x, y }]
    for (let i = 0; i < 3; i++) {
      a += qq[i]
      x += L[i] * Math.cos(a)
      y += L[i] * Math.sin(a)
      pts.push({ x, y })
    }
    return { pts, phi: a }
  }

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  const rot = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })

  // --- what the arm is aiming at right now ---------------------------------------
  function currentTarget(now) {
    if (reaching) {
      const b = reaching.body
      const g = rot(reaching.local, b.angle)
      // Like a real pick: first hover above the block, then come straight down onto it.
      const lift = reaching.phase === 'above' ? 0.09 * scale : 0
      return toWorld(b.position.x + g.x, b.position.y + g.y - lift)
    }
    if (pointer && (pressed || held || now - lastMove <= 4000)) return pointer
    // Idle: a slow figure-eight, well clear of the tower.
    const s = now / 1000
    return { x: -0.05 + 0.27 * Math.sin(s * 0.6), y: 0.4 + 0.1 * Math.sin(s * 1.2) }
  }

  // --- one physics step (1/60 s) -------------------------------------------------
  function physicsStep(tipPx) {
    if (!engine) return
    // Gripper body follows the tool point.
    const gp = gripperBody.position
    M.Body.setVelocity(gripperBody, { x: tipPx.x - gp.x, y: tipPx.y - gp.y })
    if (Math.hypot(tipPx.x - gp.x, tipPx.y - gp.y) > 40) M.Body.setPosition(gripperBody, tipPx)

    // Reaching: close the fingers once the tool point arrives at the grab point.
    if (reaching) {
      const b = reaching.body
      const g = rot(reaching.local, b.angle)
      const gx = b.position.x + g.x
      const gy = b.position.y + g.y
      if (reaching.phase === 'above' && Math.hypot(tipPx.x - gx, tipPx.y - (gy - 0.09 * scale)) < 0.025 * scale) {
        reaching.phase = 'down'
      }
      if (reaching.phase === 'down' && Math.hypot(tipPx.x - gx, tipPx.y - gy) < 0.03 * scale) {
        held = { body: b, offset: { x: b.position.x - tipPx.x, y: b.position.y - tipPx.y }, angle0: b.angle, sleep: b.sleepThreshold }
        b.sleepThreshold = Infinity // never doze off in the gripper
        b.collisionFilter.mask = CAT_BLOCK | CAT_WORLD // the gripper doesn't push what it holds
        M.Sleeping.set(b, false)
        reaching = null
        setStatus('Got it. Drag to carry, let go to drop.')
      }
    }

    // Holding: drive the block to follow the gripper, keeping its angle.
    if (held) {
      const b = held.body
      const tx = tipPx.x + held.offset.x
      const ty = tipPx.y + held.offset.y
      let vx = tx - b.position.x
      let vy = ty - b.position.y
      const v = Math.hypot(vx, vy)
      const vmax = 14
      if (v > vmax) { vx *= vmax / v; vy *= vmax / v }
      if (b.isSleeping) M.Sleeping.set(b, false)
      M.Body.setVelocity(b, { x: vx, y: vy })
      M.Body.setAngularVelocity(b, wrap(held.angle0 - b.angle) * 0.35)
    }

    M.Engine.update(engine, 1000 / 60)

    // Did the tower come down?
    if (!fallAnnounced) {
      const thick = blocks[0]?.h ?? 1
      const fallen = blocks.filter((b) => b.body !== held?.body && b.body.position.y > b.startY + thick * 1.5).length
      if (fallen >= 3) {
        fallAnnounced = true
        if (moved > best) {
          best = moved
          try { localStorage.setItem('jengaBest', String(best)) } catch { /* storage blocked */ }
        }
        updateScore()
        setStatus(`Timber! You moved ${moved} block${moved === 1 ? '' : 's'} before it fell. Reset to try again.`)
      }
    }
  }

  // --- drawing ---------------------------------------------------------------------
  const P = (p) => [base.x + p.x * scale, base.y - p.y * scale]

  function drawBlock(b) {
    const { body, w, h, end } = b
    ctx.save()
    ctx.translate(body.position.x, body.position.y)
    ctx.rotate(body.angle)
    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2)
    g.addColorStop(0, end ? '#e9c48a' : '#e3b574')
    g.addColorStop(1, end ? '#c9995a' : '#b98549')
    ctx.fillStyle = g
    ctx.strokeStyle = '#6b4423'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, 2)
    ctx.fill()
    ctx.stroke()
    // Wood grain: long lines on the side face, rings on the end grain.
    ctx.strokeStyle = 'rgba(107,68,35,0.35)'
    ctx.beginPath()
    if (end) {
      ctx.arc(-w * 0.15, h * 0.1, h * 0.28, 0, Math.PI * 2)
      ctx.moveTo(-w * 0.15 + h * 0.5, h * 0.1)
      ctx.arc(-w * 0.15, h * 0.1, h * 0.5, 0, Math.PI * 2)
    } else {
      for (const k of [-0.22, 0.05, 0.27]) {
        ctx.moveTo(-w / 2 + 4, k * h)
        ctx.bezierCurveTo(-w / 6, k * h - 2, w / 6, k * h + 2, w / 2 - 4, k * h)
      }
    }
    ctx.stroke()
    if (held && held.body === body) {
      ctx.strokeStyle = 'rgba(34,211,238,0.9)'
      ctx.lineWidth = 2
      ctx.strokeRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4)
    }
    ctx.restore()
  }

  function draw(targetShown) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // Reach circle and table.
    ctx.strokeStyle = 'rgba(34,211,238,0.18)'
    ctx.setLineDash([6, 6])
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(base.x, base.y, (L[0] + L[1] + L[2]) * scale, Math.PI, 2 * Math.PI)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(148,163,184,0.12)'
    ctx.fillRect(0, groundY, W, H - groundY)
    ctx.strokeStyle = 'rgba(148,163,184,0.45)'
    ctx.beginPath()
    ctx.moveTo(0, groundY)
    ctx.lineTo(W, groundY)
    ctx.stroke()

    for (const b of blocks) drawBlock(b)

    if (targetShown) {
      const [tx, ty] = P(targetShown)
      ctx.strokeStyle = 'rgba(249,115,22,0.85)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(tx, ty, 8, 0, 2 * Math.PI)
      ctx.moveTo(tx - 13, ty); ctx.lineTo(tx + 13, ty)
      ctx.moveTo(tx, ty - 13); ctx.lineTo(tx, ty + 13)
      ctx.stroke()
    }

    const { pts, phi } = fk(q)
    const s = pts.map(P)

    // Soft shadow of the arm on the table.
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.28)'
    ctx.filter = 'blur(6px)'
    const sx0 = Math.min(...s.map((p) => p[0])) - 10
    const sx1 = Math.max(...s.map((p) => p[0])) + 10
    ctx.beginPath()
    ctx.ellipse((sx0 + sx1) / 2, groundY + 6, (sx1 - sx0) / 2, 5, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // Pedestal: a dark column with bolts on a wide foot, and a turntable plate.
    ctx.fillStyle = '#111827'
    ctx.beginPath(); ctx.roundRect(base.x - 46, groundY - 10, 92, 12, 4); ctx.fill()
    const ped = ctx.createLinearGradient(base.x - 30, 0, base.x + 30, 0)
    ped.addColorStop(0, '#1f2937'); ped.addColorStop(0.45, '#374151'); ped.addColorStop(1, '#111827')
    ctx.fillStyle = ped
    ctx.beginPath(); ctx.roundRect(base.x - 28, base.y + 6, 56, groundY - base.y - 14, 6); ctx.fill()
    ctx.fillStyle = '#9ca3af'
    for (const bx of [-36, 36]) { ctx.beginPath(); ctx.arc(base.x + bx, groundY - 4, 2.2, 0, Math.PI * 2); ctx.fill() }
    const tt = ctx.createLinearGradient(base.x - 34, 0, base.x + 34, 0)
    tt.addColorStop(0, '#e5e7eb'); tt.addColorStop(0.5, '#ffffff'); tt.addColorStop(1, '#9ca3af')
    ctx.fillStyle = tt
    ctx.beginPath(); ctx.roundRect(base.x - 34, base.y - 2, 68, 10, 4); ctx.fill()
    ctx.fillStyle = '#f97316'
    ctx.fillRect(base.x - 34, base.y + 5, 68, 2)

    // Links: tapered metal shells lit from one side, an orange accent stripe, and a cable.
    const halfW = [[13, 10], [10, 7.5], [6.5, 5]]
    for (let i = 0; i < 3; i++) {
      const [x0, y0] = s[i]
      const [x1, y1] = s[i + 1]
      const len = Math.hypot(x1 - x0, y1 - y0) || 1
      const ux = (x1 - x0) / len, uy = (y1 - y0) / len
      const nx = -uy, ny = ux
      const [w0, w1] = halfW[i]
      ctx.beginPath()
      ctx.moveTo(x0 + nx * w0, y0 + ny * w0)
      ctx.lineTo(x1 + nx * w1, y1 + ny * w1)
      ctx.lineTo(x1 - nx * w1, y1 - ny * w1)
      ctx.lineTo(x0 - nx * w0, y0 - ny * w0)
      ctx.closePath()
      const g = ctx.createLinearGradient(x0 + nx * w0, y0 + ny * w0, x0 - nx * w0, y0 - ny * w0)
      g.addColorStop(0, '#f8fafc'); g.addColorStop(0.45, '#cbd5e1'); g.addColorStop(1, '#64748b')
      ctx.fillStyle = g
      ctx.fill()
      ctx.strokeStyle = 'rgba(15,23,42,0.85)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      if (i < 2) {
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(x0 + ux * 18, y0 + uy * 18)
        ctx.lineTo(x1 - ux * 16, y1 - uy * 16)
        ctx.stroke()
      }
      const sag = 4 + i * 2
      ctx.strokeStyle = '#0f172a'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x0 - nx * (w0 + 2), y0 - ny * (w0 + 2))
      ctx.quadraticCurveTo((x0 + x1) / 2 - nx * (w0 + sag), (y0 + y1) / 2 - ny * (w0 + sag) + 2, x1 - nx * (w1 + 2), y1 - ny * (w1 + 2))
      ctx.stroke()
    }

    // Actuator housings: dark drum, metal face, bolts and a status LED
    // (green idle, cyan moving, orange while carrying a block).
    const radii = [17, 13.5, 10]
    for (let i = 0; i < 3; i++) {
      const [x, y] = s[i]
      const r = radii[i]
      ctx.fillStyle = '#0b1220'
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.fill()
      const fg = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, 1, x, y, r)
      fg.addColorStop(0, '#f1f5f9'); fg.addColorStop(1, '#475569')
      ctx.fillStyle = fg
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#1e293b'
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + i
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * r * 0.72, y + Math.sin(a) * r * 0.72, 1.3, 0, Math.PI * 2); ctx.fill()
      }
      const moving = Math.abs(qVel[i]) > 0.15
      const led = held ? '#f97316' : moving ? '#22d3ee' : '#22c55e'
      ctx.fillStyle = led
      ctx.shadowColor = led
      ctx.shadowBlur = 10
      ctx.beginPath(); ctx.arc(x, y, r * 0.28, 0, Math.PI * 2); ctx.fill()
      ctx.shadowBlur = 0
    }

    // Gripper: wrist flange, palm, and two parallel fingers with orange pads that slide
    // together as `grip` goes to 0.
    const tip = s[3]
    const d = [Math.cos(phi), -Math.sin(phi)]
    const n = [-d[1], d[0]]
    const at = (along, side) => [tip[0] + d[0] * along + n[0] * side, tip[1] + d[1] * along + n[1] * side]
    const quad = (pp, fill) => {
      ctx.beginPath(); ctx.moveTo(...pp[0]); for (const p of pp.slice(1)) ctx.lineTo(...p); ctx.closePath()
      ctx.fillStyle = fill; ctx.fill()
      ctx.strokeStyle = 'rgba(15,23,42,0.9)'; ctx.lineWidth = 1; ctx.stroke()
    }
    quad([at(-24, -6), at(-24, 6), at(-18, 6), at(-18, -6)], '#94a3b8')
    quad([at(-18, -13), at(-18, 13), at(-11, 13), at(-11, -13)], '#1f2937')
    const open = 3 + 8 * grip
    for (const k of [-1, 1]) {
      const o = k * open
      quad([at(-11, o - k * 2.5), at(-11, o + k * 2.5), at(3, o + k * 2.5), at(3, o - k * 2.5)], '#e2e8f0')
      quad([at(-4, o - k * 2.5), at(-4, o - k * 4), at(3, o - k * 4), at(3, o - k * 2.5)], '#f97316')
    }

    if (showIK) drawIK(s, pts)
  }

  // Inverse-kinematics overlay: the shoulder-elbow-wrist triangle the law of cosines
  // solves, the wrist point, the tool link, and live joint angles.
  function drawIK(s, pts) {
    ctx.save()
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = 'rgba(34,211,238,0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(...s[0]); ctx.lineTo(...s[1]); ctx.lineTo(...s[2]); ctx.closePath(); ctx.stroke()
    ctx.strokeStyle = 'rgba(249,115,22,0.9)'
    ctx.beginPath(); ctx.moveTo(...s[2]); ctx.lineTo(...s[3]); ctx.stroke()
    ctx.setLineDash([])
    const label = (p, text, dx, dy) => {
      ctx.font = '600 11px "JetBrains Mono", monospace'
      const w = ctx.measureText(text).width + 8
      ctx.fillStyle = 'rgba(10,15,26,0.85)'
      ctx.fillRect(p[0] + dx, p[1] + dy - 11, w, 16)
      ctx.fillStyle = '#e6ebf4'
      ctx.fillText(text, p[0] + dx + 4, p[1] + dy + 1)
    }
    const deg = (a) => `${Math.round((a * 180) / Math.PI)}°`
    label(s[0], `θ1 ${deg(q[0])}`, 22, -18)
    label(s[1], `θ2 ${deg(q[1])}`, 18, -16)
    label(s[2], `θ3 ${deg(q[2])}`, 14, -14)
    ctx.fillStyle = '#22d3ee'
    ctx.beginPath(); ctx.arc(...s[2], 4, 0, Math.PI * 2); ctx.fill()
    const tipM = pts[3]
    label(s[3], `tool (${tipM.x.toFixed(2)}, ${tipM.y.toFixed(2)}) m`, 14, 24)
    ctx.restore()
  }

  // --- main loop -----------------------------------------------------------------
  let last = performance.now()
  let acc = 0
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const t = currentTarget(now)
    const goal = solve(t)
    if (goal) {
      const maxStep = (reduce ? 1.4 : 3.4) * dt // servo speed limit (rad per frame)
      const q0 = q
      q = q.map((v, i) => {
        const e = wrap(goal[i] - v)
        return v + Math.max(-maxStep, Math.min(maxStep, e * 0.2 + Math.sign(e) * Math.min(Math.abs(e), maxStep * 0.4)))
      })
      qVel = q.map((v, i) => (dt > 0 ? (v - q0[i]) / dt : 0))
    }
    grip += ((held ? 0 : 1) - grip) * Math.min(1, dt * 12)

    if (engine) {
      const tipM = fk(q).pts[3]
      const tipPx = toPx(tipM)
      acc += dt
      while (acc >= 1 / 60) {
        physicsStep(tipPx)
        acc -= 1 / 60
      }
    }
    requestAnimationFrame(tick)
    if (!W || canvas.offsetParent === null) return
    draw(pointer && (pressed || held || now - lastMove <= 4000) && !reaching ? pointer : null)
  }

  // --- input ---------------------------------------------------------------------
  function localPx(e) {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function onMove(e) {
    const p = localPx(e)
    pointer = toWorld(p.x, p.y)
    lastMove = performance.now()
  }
  canvas.addEventListener('pointerdown', (e) => {
    onMove(e)
    pressed = true
    try { canvas.setPointerCapture(e.pointerId) } catch { /* keep going without capture */ }
    if (!engine) return
    const p = localPx(e)
    const hit = M.Query.point(blocks.map((b) => b.body), p)[0]
    if (hit) {
      // Remember where on the block we grabbed it, in the block's own frame.
      const local = rot({ x: p.x - hit.position.x, y: p.y - hit.position.y }, -hit.angle)
      reaching = { body: hit, local, phase: 'above' }
      hit.collisionFilter.mask = CAT_BLOCK | CAT_WORLD // the fingers close around it rather than shove it
      setStatus('Keep holding: the arm is reaching for the block…')
      e.preventDefault()
    }
  })
  canvas.addEventListener('pointermove', onMove)
  const release = () => {
    pressed = false
    if (held) {
      const b = held.body
      b.collisionFilter.mask = CAT_BLOCK | CAT_GRIPPER | CAT_WORLD
      b.sleepThreshold = held.sleep
      M.Sleeping.set(b, false) // let gravity take it from here
      const v = b.velocity
      const s = Math.hypot(v.x, v.y)
      if (s > 18) M.Body.setVelocity(b, { x: (v.x * 18) / s, y: (v.y * 18) / s })
      held = null
      if (!fallAnnounced) {
        moved++
        updateScore()
        setStatus(`Dropped. Will it balance? (${moved} moved)`)
      }
    } else if (reaching) {
      reaching.body.collisionFilter.mask = CAT_BLOCK | CAT_GRIPPER | CAT_WORLD
      setStatus('Let go too early: hold until the fingers close.')
    }
    reaching = null
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  // Follow the mouse anywhere over the play section, not only inside the canvas.
  document.querySelector('.play')?.addEventListener('pointermove', (e) => {
    if (!pressed) onMove(e)
  })
  resetBtn?.addEventListener('click', () => buildWorld())
  ikBtn?.addEventListener('click', () => {
    showIK = !showIK
    ikBtn.setAttribute('aria-pressed', String(showIK))
    ikBtn.textContent = showIK ? 'Hide IK' : 'Show IK'
  })
  // Debug view of the physics state (only with ?debug in the URL).
  if (location.search.includes('debug')) {
    window.__jenga = () => ({
      held: !!held,
      reaching: !!reaching,
      blocks: blocks.map((b) => ({ x: Math.round(b.body.position.x), y: Math.round(b.body.position.y), a: +b.body.angle.toFixed(2), sleep: b.body.isSleeping, startY: Math.round(b.startY) })),
      groundY,
    })
  }

  resize()
  let rt = 0
  window.addEventListener('resize', () => {
    clearTimeout(rt)
    rt = setTimeout(resize, 150)
  })
  requestAnimationFrame(tick)
})()
