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
  const CAT_BLOCK = 0x0001
  const CAT_GRIPPER = 0x0002
  const CAT_WORLD = 0x0004

  function resize() {
    const r = canvas.getBoundingClientRect()
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
        setStatus('Timber! The tower fell. Press Reset to stack it again.')
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

    // Base.
    ctx.fillStyle = '#1f2937'
    ctx.beginPath()
    ctx.roundRect(base.x - 34, base.y + 2, 68, groundY - base.y - 2, 5)
    ctx.fill()
    ctx.fillStyle = '#f472b6'
    ctx.beginPath()
    ctx.roundRect(base.x - 28, base.y - 6, 56, 10, 4)
    ctx.fill()

    // Links.
    const { pts, phi } = fk(q)
    const s = pts.map(P)
    const widths = [22, 18, 12]
    ctx.lineCap = 'round'
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = '#0b1220'
      ctx.lineWidth = widths[i] + 6
      ctx.beginPath(); ctx.moveTo(...s[i]); ctx.lineTo(...s[i + 1]); ctx.stroke()
      const g = ctx.createLinearGradient(...s[i], ...s[i + 1])
      g.addColorStop(0, '#e2e8f0'); g.addColorStop(1, '#94a3b8')
      ctx.strokeStyle = g
      ctx.lineWidth = widths[i]
      ctx.beginPath(); ctx.moveTo(...s[i]); ctx.lineTo(...s[i + 1]); ctx.stroke()
      if (i < 2) {
        ctx.strokeStyle = '#f97316'
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.moveTo(...s[i]); ctx.lineTo(...s[i + 1]); ctx.stroke()
      }
    }
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = '#0b1220'
      ctx.beginPath(); ctx.arc(...s[i], i === 0 ? 15 : 12, 0, 2 * Math.PI); ctx.fill()
      ctx.strokeStyle = '#22d3ee'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(...s[i], i === 0 ? 11 : 8, 0, 2 * Math.PI); ctx.stroke()
    }

    // Gripper: palm and two fingers that close as `grip` goes to 0.
    const tip = s[3]
    const d = [Math.cos(phi), -Math.sin(phi)]
    const n = [-d[1], d[0]]
    const open = 4 + 8 * grip
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 4
    for (const k of [-1, 1]) {
      const bx = tip[0] - d[0] * 14 + n[0] * k * open
      const by = tip[1] - d[1] * 14 + n[1] * k * open
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + d[0] * 15, by + d[1] * 15); ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo(tip[0] - d[0] * 14 - n[0] * (open + 2), tip[1] - d[1] * 14 - n[1] * (open + 2))
    ctx.lineTo(tip[0] - d[0] * 14 + n[0] * (open + 2), tip[1] - d[1] * 14 + n[1] * (open + 2))
    ctx.stroke()
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
      q = q.map((v, i) => {
        const e = wrap(goal[i] - v)
        return v + Math.max(-maxStep, Math.min(maxStep, e * 0.2 + Math.sign(e) * Math.min(Math.abs(e), maxStep * 0.4)))
      })
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
    draw(pointer && (pressed || held || now - lastMove <= 4000) && !reaching ? pointer : null)
    requestAnimationFrame(tick)
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
      if (!fallAnnounced) setStatus('Dropped. Will it balance?')
    } else if (reaching) {
      reaching.body.collisionFilter.mask = CAT_BLOCK | CAT_GRIPPER | CAT_WORLD
      setStatus('Let go too early: hold until the fingers close.')
    }
    reaching = null
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  // Follow the mouse anywhere over the hero, not only inside the canvas.
  document.querySelector('.hero')?.addEventListener('pointermove', (e) => {
    if (!pressed) onMove(e)
  })
  resetBtn?.addEventListener('click', () => buildWorld())
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
