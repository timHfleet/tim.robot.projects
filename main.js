// Hero robot arm: a 3-link planar arm that reaches for the cursor.
// Same idea as the simulator's analytic IK: pick the tool angle, back off the
// last link to find the wrist, then solve the 2-link triangle with the law of
// cosines. The joints move like servos (rate-limited), so the arm glides
// instead of snapping.
(() => {
  const canvas = document.getElementById('arm')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let W = 0, H = 0, dpr = 1, scale = 1
  const L = [0.34, 0.3, 0.12] // link lengths (m), like the simulator
  const base = { x: 0, y: 0 } // in pixels, set on resize
  let q = [1.9, -1.7, -1.4] // shoulder, elbow, wrist (rad, relative)
  let target = null // in metres, relative to the shoulder
  let lastMove = -1e9

  function resize() {
    const r = canvas.getBoundingClientRect()
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    W = r.width
    H = r.height
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    scale = Math.min(W / 1.7, H / 0.95) // pixels per metre
    base.x = W * 0.5
    base.y = H * 0.84
  }

  const toWorld = (px, py) => ({ x: (px - base.x) / scale, y: (base.y - py) / scale })

  // Analytic IK for a target point with the tool pointing at angle phi.
  function ik(t, phi) {
    const wx = t.x - L[2] * Math.cos(phi)
    const wy = t.y - L[2] * Math.sin(phi)
    const d2 = wx * wx + wy * wy
    let c = (d2 - L[0] * L[0] - L[1] * L[1]) / (2 * L[0] * L[1])
    if (c > 1 || c < -1) return null
    const q2 = -Math.acos(c) // elbow up
    const q1 = Math.atan2(wy, wx) - Math.atan2(L[1] * Math.sin(q2), L[0] + L[1] * Math.cos(q2))
    return [q1, q2, phi - q1 - q2]
  }

  // Reach the point: try the tool angles closest to pointing down, then wider.
  function solve(t) {
    const maxR = L[0] + L[1] + L[2] - 0.005
    const r = Math.hypot(t.x, t.y)
    if (r > maxR) t = { x: (t.x / r) * maxR, y: (t.y / r) * maxR }
    if (t.y < -0.05) t = { x: t.x, y: -0.05 }
    const down = -Math.PI / 2
    const aim = Math.atan2(t.y, t.x)
    for (let k = 0; k <= 36; k++) {
      for (const s of [1, -1]) {
        const phi = down + s * k * (Math.PI / 36)
        const sol = ik(t, k === 36 ? aim : phi)
        if (sol) return sol
      }
    }
    return ik(t, aim)
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

  const P = (p) => [base.x + p.x * scale, base.y - p.y * scale]

  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI
    while (a < -Math.PI) a += 2 * Math.PI
    return a
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    // Reach circle and table line.
    const reach = (L[0] + L[1] + L[2]) * scale
    ctx.strokeStyle = 'rgba(34,211,238,0.18)'
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.arc(base.x, base.y, reach, Math.PI, 2 * Math.PI)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = 'rgba(148,163,184,0.35)'
    ctx.beginPath()
    ctx.moveTo(0, base.y + 20)
    ctx.lineTo(W, base.y + 20)
    ctx.stroke()

    // Target marker.
    if (t) {
      const [tx, ty] = P(t)
      ctx.strokeStyle = 'rgba(249,115,22,0.9)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(tx, ty, 9, 0, 2 * Math.PI)
      ctx.moveTo(tx - 15, ty); ctx.lineTo(tx + 15, ty)
      ctx.moveTo(tx, ty - 15); ctx.lineTo(tx, ty + 15)
      ctx.stroke()
    }

    // Base.
    ctx.fillStyle = '#1f2937'
    ctx.beginPath()
    ctx.roundRect(base.x - 34, base.y + 2, 68, 18, 5)
    ctx.fill()
    ctx.fillStyle = '#f472b6'
    ctx.beginPath()
    ctx.roundRect(base.x - 28, base.y - 6, 56, 10, 4)
    ctx.fill()

    // Links.
    const { pts, phi } = fk(q)
    const s = pts.map(P)
    const widths = [22, 18, 12]
    for (let i = 0; i < 3; i++) {
      ctx.lineCap = 'round'
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
    // Joints.
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = '#0b1220'
      ctx.beginPath(); ctx.arc(...s[i], i === 0 ? 15 : 12, 0, 2 * Math.PI); ctx.fill()
      ctx.strokeStyle = '#22d3ee'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(...s[i], i === 0 ? 11 : 8, 0, 2 * Math.PI); ctx.stroke()
    }
    // Gripper fingers at the tool point.
    const tip = s[3]
    const d = [Math.cos(phi), -Math.sin(phi)]
    const n = [-d[1], d[0]]
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 4
    for (const k of [-1, 1]) {
      const bx = tip[0] - d[0] * 14 + n[0] * k * 9
      const by = tip[1] - d[1] * 14 + n[1] * k * 9
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + d[0] * 14, by + d[1] * 14); ctx.stroke()
    }
    ctx.beginPath()
    ctx.moveTo(tip[0] - d[0] * 14 - n[0] * 10, tip[1] - d[1] * 14 - n[1] * 10)
    ctx.lineTo(tip[0] - d[0] * 14 + n[0] * 10, tip[1] - d[1] * 14 + n[1] * 10)
    ctx.stroke()
  }

  let last = performance.now()
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    // Idle: trace a slow figure-eight until the visitor moves the mouse.
    let t = target
    if (!t || now - lastMove > 4000) {
      const s = now / 1000
      t = { x: 0.32 * Math.sin(s * 0.6), y: 0.36 + 0.12 * Math.sin(s * 1.2) }
    }
    const goal = solve(t)
    if (goal) {
      const maxStep = (reduce ? 1.2 : 3.2) * dt // rad per frame: servo speed limit
      q = q.map((v, i) => {
        const e = wrap(goal[i] - v)
        return v + Math.max(-maxStep, Math.min(maxStep, e * 0.18 + Math.sign(e) * Math.min(Math.abs(e), maxStep * 0.4)))
      })
    }
    draw(target && now - lastMove <= 4000 ? target : null)
    requestAnimationFrame(tick)
  }

  function onPoint(e) {
    const r = canvas.getBoundingClientRect()
    target = toWorld(e.clientX - r.left, e.clientY - r.top)
    lastMove = performance.now()
  }

  resize()
  window.addEventListener('resize', resize)
  canvas.addEventListener('pointermove', onPoint)
  canvas.addEventListener('pointerdown', onPoint)
  // Follow the mouse anywhere over the hero, not only inside the canvas.
  document.querySelector('.hero')?.addEventListener('pointermove', onPoint)
  requestAnimationFrame(tick)
})()
