// Fold-Off: fold a towel into quarters with HMN-2's two arms, seen from above.
//
// You pick where both grippers grab the towel's edge, then where to lay them down.
// The fold line is the perpendicular bisector of that carry, like folding paper:
// everything on the grippers' side of the line flips over onto the rest.
//
// The towel is a stack of layers. Each layer is a convex patch of the flat towel
// (in towel coordinates) plus an affine map that places it on the table. A fold
// clips every layer by the line and reflects the flap side, so the texture,
// stripes and the towel's back side all follow the cloth. The fold animation
// squashes the flap across the line by cos(angle), which is also affine.
//
// Score: neatness (a perfect quarter fold covers exactly 1/4 of the towel's
// area; we measure the folded towel's outline), minus time and regrasps.
(() => {
  const canvas = document.getElementById('fold')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const statusEl = document.getElementById('fold-status')
  const scoreEl = document.getElementById('fold-score')
  const resetBtn = document.getElementById('fold-reset')

  const FOLDS = 2
  const EDGE_PX = 18 // how close to the towel's edge a gripper must grab
  const COLORS = [
    { face: '#2a9d8f', back: '#1f7a6f', band: '#e9f5f2', hem: '#17594f' },
    { face: '#e76f51', back: '#b9543b', band: '#fff1e8', hem: '#8f3d29' },
    { face: '#6d83c9', back: '#5568a6', band: '#eef1fb', hem: '#3c4b7d' },
    { face: '#e9c46a', back: '#c9a54c', band: '#fffaf0', hem: '#9a7a2c' },
  ]

  let W = 0, H = 0, dpr = 1
  const TABLE = { x: 0, y: 0, w: 0, h: 0 }
  let towel = null // { w, h, area, color, layers: [{ poly, m }] }
  let state = 'grasp1' // grasp1 | grasp2 | aim | anim | done
  let grasps = [] // world points
  let aimAt = null // world point the grippers are carried to
  let anim = null // { t0, n, c, flap, kept, from: [p, p], to: [p, p] }
  let folds = 0
  let regrasps = 0
  let t0 = 0 // first click time
  let tEnd = 0
  let best = 0
  let msg = null // { text, until } short flash over the towel
  let visible = true
  try { best = +localStorage.getItem('foldBest') || 0 } catch { /* storage blocked */ }

  // --- robot geometry (top view, CSS pixels) --------------------------------------
  const robot = { cx: 0, cy: 0, sh: [{ x: 0, y: 0 }, { x: 0, y: 0 }], L1: 0, L2: 0, rest: [{ x: 0, y: 0 }, { x: 0, y: 0 }] }
  const hands = [{ x: 0, y: 0, lift: 0, closed: 0 }, { x: 0, y: 0, lift: 0, closed: 0 }]

  // --- affine maps: [a, b, c, d, e, f], x' = a x + c y + e, y' = b x + d y + f ---
  const ap = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] })
  const mul = (A, B) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ]
  const det = (m) => m[0] * m[3] - m[1] * m[2]
  // Squash across the line n·p = c by factor k: k = 1 is identity, k = -1 a reflection.
  const squash = (n, c, k) => {
    const s = 1 - k
    return [1 - s * n.x * n.x, -s * n.x * n.y, -s * n.x * n.y, 1 - s * n.y * n.y, s * c * n.x, s * c * n.y]
  }

  const area = (pts) => {
    let a = 0
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length]
      a += p.x * q.y - q.x * p.y
    }
    return Math.abs(a) / 2
  }

  // Keep the part of a convex polygon where n·p - c has the given sign.
  function clip(poly, n, c, keepNeg) {
    const out = []
    const side = (p) => (n.x * p.x + n.y * p.y - c) * (keepNeg ? -1 : 1)
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length]
      const sp = side(p), sq = side(q)
      if (sp >= 0) out.push(p)
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq)
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      }
    }
    return out.length >= 3 ? out : null
  }

  // The world line n·p = c, expressed in a layer's towel coordinates.
  function lineIn(m, n, c) {
    return { n: { x: m[0] * n.x + m[1] * n.y, y: m[2] * n.x + m[3] * n.y }, c: c - (n.x * m[4] + n.y * m[5]) }
  }

  const worldPoly = (L) => L.poly.map((p) => ap(L.m, p))

  function hull(points) {
    const P = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
    if (P.length < 3) return P
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
    const lo = [], up = []
    for (const p of P) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop()
      lo.push(p)
    }
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop()
      up.push(p)
    }
    return lo.slice(0, -1).concat(up.slice(0, -1))
  }
  const outline = () => hull(towel.layers.flatMap(worldPoly))

  // Signed distance to a convex outline: negative inside.
  function edgeDist(p, poly) {
    let best = Infinity
    let inside = true
    let sign = 0
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const abx = b.x - a.x, aby = b.y - a.y
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby)))
      best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)))
      const cr = abx * (p.y - a.y) - aby * (p.x - a.x)
      if (cr !== 0) {
        if (sign === 0) sign = Math.sign(cr)
        else if (Math.sign(cr) !== sign) inside = false
      }
    }
    return inside ? -best : best
  }

  // --- setup ------------------------------------------------------------------------
  function resize() {
    const r = canvas.getBoundingClientRect()
    if (r.width < 10) return
    const oldW = W
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    W = r.width
    H = r.height
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    robot.cx = W / 2
    robot.cy = H * 0.985
    robot.sh[0] = { x: W / 2 - W * 0.11, y: H * 0.9 }
    robot.sh[1] = { x: W / 2 + W * 0.11, y: H * 0.9 }
    robot.L1 = H * 0.37
    robot.L2 = H * 0.37
    robot.rest[0] = { x: W / 2 - W * 0.27, y: H * 0.56 }
    robot.rest[1] = { x: W / 2 + W * 0.27, y: H * 0.56 }
    // Keep the table clear of the status overlay, which wraps onto more rows on phones.
    const top = W < 500 ? Math.max(H * 0.15, 100) : H * 0.15
    Object.assign(TABLE, { x: W * 0.05, y: top, w: W * 0.9, h: H * 0.8 - top })
    if (!towel || Math.abs(oldW - W) > 1) newTowel()
  }

  function newTowel() {
    const w = W * 0.46
    const h = W * 0.29
    const ang = (Math.random() - 0.5) * 0.5
    const cx = W * (0.5 + (Math.random() - 0.5) * 0.08)
    const cy = TABLE.y + TABLE.h * (0.5 + (Math.random() - 0.5) * 0.06)
    const cos = Math.cos(ang), sin = Math.sin(ang)
    towel = {
      w, h, area: w * h,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      layers: [{
        poly: [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }],
        m: [cos, sin, -sin, cos, cx, cy],
      }],
    }
    state = 'grasp1'
    grasps = []
    aimAt = null
    anim = null
    folds = 0
    regrasps = 0
    t0 = 0
    tEnd = 0
    for (let i = 0; i < 2; i++) Object.assign(hands[i], robot.rest[i], { lift: 0, closed: 0 })
    setStatus('Click the towel’s edge to place the first gripper.')
    updateScore()
  }

  function setStatus(t) { if (statusEl) statusEl.textContent = t }
  const elapsed = () => (t0 ? ((tEnd || performance.now()) - t0) / 1000 : 0)
  function updateScore() {
    if (scoreEl) scoreEl.textContent = `Folds ${folds}/${FOLDS} · ${elapsed().toFixed(1)} s · Regrasps ${regrasps} · Best ${best}`
  }
  function flash(text) { msg = { text, until: performance.now() + 1600 } }

  // --- arm kinematics: 2-link IK, elbow bent outward ----------------------------------
  function elbow(i, t) {
    const s = robot.sh[i]
    const L1 = robot.L1, L2 = robot.L2
    let d = Math.hypot(t.x - s.x, t.y - s.y)
    d = Math.max(Math.abs(L1 - L2) + 1, Math.min(L1 + L2 - 0.5, d))
    const base = Math.atan2(t.y - s.y, t.x - s.x)
    const a = Math.acos(Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))))
    const e1 = { x: s.x + L1 * Math.cos(base + a), y: s.y + L1 * Math.sin(base + a) }
    const e2 = { x: s.x + L1 * Math.cos(base - a), y: s.y + L1 * Math.sin(base - a) }
    // Prefer the elbow that sticks out sideways, unless that pushes it off the canvas.
    const out1 = Math.abs(e1.x - W / 2) > Math.abs(e2.x - W / 2)
    const [o, inn] = out1 ? [e1, e2] : [e2, e1]
    return o.y > H * 0.97 ? inn : o
  }

  // --- the fold itself ------------------------------------------------------------------
  // Grippers at g0, g1 carried so their midpoint lands on `to`. Returns the fold line
  // (unit normal n pointing away from the flap, offset c) or a reason it won't work.
  function planFold(to) {
    const m = { x: (grasps[0].x + grasps[1].x) / 2, y: (grasps[0].y + grasps[1].y) / 2 }
    const vx = to.x - m.x, vy = to.y - m.y
    const len = Math.hypot(vx, vy)
    if (len < 16) return { err: 'Drag farther to fold.' }
    const n = { x: vx / len, y: vy / len }
    const c = n.x * (m.x + vx / 2) + n.y * (m.y + vy / 2)
    for (const g of grasps) if (n.x * g.x + n.y * g.y - c > -2) return { err: 'Both grippers must be on the flap.', n, c }
    let flapArea = 0
    for (const L of towel.layers) {
      const neg = clip(worldPoly(L), n, c, true)
      if (neg) flapArea += area(neg)
    }
    if (flapArea < towel.area * 0.08) return { err: 'That barely folds anything.', n, c }
    const dest = grasps.map((g) => ap(squash(n, c, -1), g))
    return { n, c, dest }
  }

  function startFold(plan) {
    const kept = []
    const flap = []
    for (const L of towel.layers) {
      const ln = lineIn(L.m, plan.n, plan.c)
      const pos = clip(L.poly, ln.n, ln.c, false)
      const neg = clip(L.poly, ln.n, ln.c, true)
      if (pos) kept.push({ poly: pos, m: L.m })
      if (neg) flap.push({ poly: neg, m: L.m })
    }
    // Assign grasps to the arms by side: left arm takes the leftmost point.
    let from = grasps.slice()
    let to = plan.dest.slice()
    if (from[0].x > from[1].x) { from = [from[1], from[0]]; to = [to[1], to[0]] }
    anim = { t0: performance.now(), n: plan.n, c: plan.c, kept, flap, from, to }
    state = 'anim'
    setStatus('Folding…')
  }

  const DUR = reduce ? { reach: 0.25, fold: 0.5, back: 0.2 } : { reach: 0.55, fold: 1.0, back: 0.45 }
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

  // Fold progress 0..1 and the hand targets for the current moment.
  function animStep(now) {
    const t = (now - anim.t0) / 1000
    let f = 0
    if (t < DUR.reach) {
      const k = ease(t / DUR.reach)
      for (let i = 0; i < 2; i++) {
        hands[i].x = robot.rest[i].x + (anim.from[i].x - robot.rest[i].x) * k
        hands[i].y = robot.rest[i].y + (anim.from[i].y - robot.rest[i].y) * k
        hands[i].closed = Math.max(0, (k - 0.7) / 0.3)
        hands[i].lift = 0
      }
    } else if (t < DUR.reach + DUR.fold) {
      f = ease((t - DUR.reach) / DUR.fold)
      const M = squash(anim.n, anim.c, Math.cos(f * Math.PI))
      for (let i = 0; i < 2; i++) {
        Object.assign(hands[i], ap(M, anim.from[i]))
        hands[i].closed = 1
        hands[i].lift = Math.sin(f * Math.PI)
      }
    } else if (t < DUR.reach + DUR.fold + DUR.back) {
      f = 1
      const k = ease((t - DUR.reach - DUR.fold) / DUR.back)
      for (let i = 0; i < 2; i++) {
        hands[i].x = anim.to[i].x + (robot.rest[i].x - anim.to[i].x) * k
        hands[i].y = anim.to[i].y + (robot.rest[i].y - anim.to[i].y) * k
        hands[i].closed = Math.max(0, 1 - k * 3)
        hands[i].lift = 0
      }
    } else {
      finishFold()
      return 1
    }
    return f
  }

  function finishFold() {
    const R = squash(anim.n, anim.c, -1)
    towel.layers = anim.kept.concat(anim.flap.slice().reverse().map((L) => ({ poly: L.poly, m: mul(R, L.m) })))
    anim = null
    grasps = []
    aimAt = null
    folds++
    for (let i = 0; i < 2; i++) Object.assign(hands[i], robot.rest[i], { lift: 0, closed: 0 })
    if (folds >= FOLDS) {
      finishGame()
    } else {
      state = 'grasp1'
      setStatus('Half way. Grab the edge again for the second fold.')
    }
    updateScore()
  }

  function finishGame() {
    state = 'done'
    tEnd = performance.now()
    const neat = Math.min(1, towel.area / 4 / area(outline()))
    const secs = elapsed()
    const score = Math.max(0, Math.round(neat * 1000 - secs * 5 - regrasps * 50))
    const grade = neat >= 0.95 ? 'Shelf-ready' : neat >= 0.85 ? 'Tidy' : neat >= 0.7 ? 'Good enough' : 'Laundry pile'
    const isBest = score > best
    if (isBest) {
      best = score
      try { localStorage.setItem('foldBest', String(best)) } catch { /* storage blocked */ }
    }
    setStatus(`${grade}: ${Math.round(neat * 100)}% neat in ${secs.toFixed(1)} s. Score ${score}${isBest ? ' (new best!)' : ''}. Press New towel to go again.`)
    flash(`${grade} · ${score}`)
  }

  // --- input ------------------------------------------------------------------------
  const pt = (e) => {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!towel) resize() // first click can beat the ResizeObserver after the tab opens
    if (state === 'anim' || state === 'done' || !towel) return
    const p = pt(e)
    if (state === 'grasp1' || state === 'grasp2') {
      if (!t0) t0 = performance.now()
      const d = edgeDist(p, outline())
      if (d > EDGE_PX || d < -EDGE_PX) {
        regrasps++
        flash(d > EDGE_PX ? 'Missed the towel. Regrasp.' : 'Cloth slipped: grab nearer an edge.')
        updateScore()
        return
      }
      const i = state === 'grasp1' ? 0 : 1
      if (i === 1 && Math.hypot(p.x - grasps[0].x, p.y - grasps[0].y) < 30) {
        flash('Spread the grippers further apart.')
        return
      }
      grasps.push(p)
      if (i === 0) {
        state = 'grasp2'
        setStatus('Now the second gripper, somewhere else on the edge.')
      } else {
        state = 'aim'
        aimAt = p
        setStatus('Drag to where the grippers should lay the flap down, then let go.')
        canvas.setPointerCapture?.(e.pointerId)
      }
      return
    }
    if (state === 'aim') {
      aimAt = p
      canvas.setPointerCapture?.(e.pointerId)
    }
  })
  canvas.addEventListener('pointermove', (e) => {
    if (state === 'aim') aimAt = pt(e)
  })
  canvas.addEventListener('pointerup', (e) => {
    if (state !== 'aim' || !grasps[1]) return
    const p = pt(e)
    // Releasing right where the second gripper went down means "now aim": wait for a drag.
    if (Math.hypot(p.x - grasps[1].x, p.y - grasps[1].y) < 6) return
    const plan = planFold(p)
    if (plan.err) { flash(plan.err); return }
    startFold(plan)
  })
  canvas.addEventListener('contextmenu', (e) => {
    if (state === 'aim' || state === 'grasp2') {
      e.preventDefault()
      grasps = []
      state = 'grasp1'
      setStatus('Grippers released. Click the towel’s edge to start again.')
    }
  })
  resetBtn?.addEventListener('click', () => { newTowel(); flash('Fresh towel.') })

  // --- drawing ----------------------------------------------------------------------
  const terry = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 32
    const g = c.getContext('2d')
    for (let i = 0; i < 260; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)'
      g.fillRect(Math.random() * 32, Math.random() * 32, 1.4, 1.4)
    }
    return c
  })()
  let terryPat = null

  function drawLayer(L, M, shadeK) {
    const m = M ? mul(M, L.m) : L.m
    const back = det(m) < 0
    const col = towel.color
    ctx.save()
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.beginPath()
    L.poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
    ctx.save()
    ctx.clip()
    const w = towel.w, h = towel.h
    ctx.fillStyle = back ? col.back : col.face
    ctx.fillRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4)
    // Woven bands near both ends, and a hem all round.
    ctx.fillStyle = col.band
    for (const s of [-1, 1]) {
      ctx.globalAlpha = back ? 0.55 : 0.85
      ctx.fillRect(s * w * 0.36 - w * 0.03, -h / 2, w * 0.06, h)
      ctx.globalAlpha = back ? 0.35 : 0.6
      ctx.fillRect(s * w * 0.42 - w * 0.008, -h / 2, w * 0.016, h)
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = col.hem
    ctx.lineWidth = 5
    ctx.strokeRect(-w / 2, -h / 2, w, h)
    if (!terryPat) terryPat = ctx.createPattern(terry, 'repeat')
    ctx.fillStyle = terryPat
    ctx.fillRect(-w / 2, -h / 2, w, h)
    if (shadeK !== undefined) {
      // Light falls off as the flap tilts up.
      ctx.fillStyle = `rgba(0,0,0,${0.22 * (1 - Math.abs(shadeK))})`
      ctx.fillRect(-w / 2, -h / 2, w, h)
    }
    ctx.restore()
    ctx.restore()
    // A thin edge in world space so folds read clearly.
    ctx.beginPath()
    L.poly.forEach((p, i) => { const q = ap(m, p); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y) })
    ctx.closePath()
    ctx.strokeStyle = 'rgba(15,23,42,0.45)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  function pathOf(pts) {
    ctx.beginPath()
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
  }

  function drawTable() {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#1b2334')
    g.addColorStop(1, '#111827')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.roundRect(TABLE.x, TABLE.y, TABLE.w, TABLE.h, 18)
    ctx.fill()
    ctx.strokeStyle = 'rgba(148,163,184,0.18)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.fillStyle = 'rgba(148,163,184,0.5)'
    ctx.font = '600 10px "JetBrains Mono", monospace'
    ctx.textAlign = 'left'
    ctx.fillText('FOLDING TABLE', TABLE.x + 12, TABLE.y + TABLE.h - 12)
  }

  function drawRobot() {
    const { cx, cy } = robot
    // Base: the mobile base seen from above, mostly below the canvas edge.
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.beginPath(); ctx.roundRect(cx - W * 0.19, cy - H * 0.12 + 6, W * 0.38, H * 0.2, 16); ctx.fill()
    const g = ctx.createLinearGradient(0, cy - H * 0.12, 0, cy + H * 0.08)
    g.addColorStop(0, '#334155'); g.addColorStop(1, '#0f172a')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.roundRect(cx - W * 0.19, cy - H * 0.12, W * 0.38, H * 0.2, 16); ctx.fill()
    ctx.strokeStyle = 'rgba(34,211,238,0.35)'; ctx.lineWidth = 1.5; ctx.stroke()
    // Front base camera.
    ctx.fillStyle = '#0b1220'
    ctx.beginPath(); ctx.roundRect(cx - 9, cy - H * 0.12 - 3, 18, 7, 3); ctx.fill()
    ctx.fillStyle = '#22d3ee'
    ctx.beginPath(); ctx.arc(cx, cy - H * 0.12 + 0.5, 2, 0, Math.PI * 2); ctx.fill()
    // Shoulder bar and head.
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 12; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(robot.sh[0].x, robot.sh[0].y); ctx.lineTo(robot.sh[1].x, robot.sh[1].y); ctx.stroke()
    ctx.fillStyle = '#e2e8f0'
    ctx.beginPath(); ctx.arc(cx, H * 0.9, W * 0.04, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#0b1220'
    ctx.beginPath(); ctx.roundRect(cx - W * 0.026, H * 0.9 - W * 0.04 - 2, W * 0.052, 8, 4); ctx.fill()
    ctx.fillStyle = '#22d3ee'
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + s * W * 0.012, H * 0.9 - W * 0.04 + 2, 1.8, 0, Math.PI * 2); ctx.fill() }
  }

  function drawArm(i) {
    const s = robot.sh[i]
    const h = hands[i]
    const e = elbow(i, h)
    const lift = h.lift
    // Shadow of the arm on the table, offset more when lifted.
    ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'
    ctx.lineWidth = 14
    const so = 4 + lift * 14
    ctx.beginPath(); ctx.moveTo(s.x + 4, s.y + 4); ctx.lineTo(e.x + so * 0.6, e.y + so * 0.6); ctx.lineTo(h.x + so, h.y + so); ctx.stroke()
    // Links.
    for (const [a, b, w] of [[s, e, 15], [e, h, 12]]) {
      ctx.strokeStyle = '#0f172a'; ctx.lineWidth = w + 3
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = w
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      ctx.strokeStyle = 'rgba(148,163,184,0.6)'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    }
    // Joints.
    for (const p of [s, e]) {
      ctx.fillStyle = '#111827'
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke()
    }
    // Gripper: two fingers along the forearm, closing when it holds cloth.
    const ang = Math.atan2(h.y - e.y, h.x - e.x)
    const sc = 1 + lift * 0.3
    ctx.save()
    ctx.translate(h.x, h.y)
    ctx.rotate(ang)
    ctx.scale(sc, sc)
    ctx.fillStyle = '#111827'
    ctx.beginPath(); ctx.roundRect(-8, -9, 12, 18, 4); ctx.fill()
    const open = 7 - h.closed * 5
    ctx.fillStyle = '#94a3b8'
    for (const sgn of [-1, 1]) {
      ctx.beginPath(); ctx.roundRect(2, sgn * open - 2, 14, 4, 2); ctx.fill()
    }
    ctx.fillStyle = h.closed > 0.5 ? '#22c55e' : '#22d3ee' // wrist LED
    ctx.beginPath(); ctx.arc(-3, 0, 2.2, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
  }

  function drawGrasp(p, label) {
    ctx.strokeStyle = '#22d3ee'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = 'rgba(34,211,238,0.25)'
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#e6ebf4'
    ctx.font = '600 10px Inter, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(label, p.x, p.y - 14)
  }

  function arrow(a, b, color) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 2
    ctx.setLineDash([5, 5])
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4))
    ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4))
    ctx.closePath()
    ctx.fill()
  }

  function drawAim() {
    if (state !== 'aim' || !aimAt || !grasps[1]) return
    const plan = planFold(aimAt)
    if (!plan.n) return
    const bad = !!plan.err
    // Fold line across the table.
    const { n, c } = plan
    const p0 = { x: n.x * c, y: n.y * c }
    const dir = { x: -n.y, y: n.x }
    const big = W + H
    ctx.save()
    ctx.beginPath(); ctx.roundRect(TABLE.x, TABLE.y, TABLE.w, TABLE.h, 18); ctx.clip()
    ctx.strokeStyle = bad ? 'rgba(248,113,113,0.8)' : 'rgba(34,211,238,0.9)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([8, 6])
    ctx.beginPath(); ctx.moveTo(p0.x - dir.x * big, p0.y - dir.y * big); ctx.lineTo(p0.x + dir.x * big, p0.y + dir.y * big); ctx.stroke()
    ctx.setLineDash([])
    // Ghost of where the flap will land.
    const R = squash(n, c, -1)
    ctx.strokeStyle = bad ? 'rgba(248,113,113,0.7)' : 'rgba(249,115,22,0.9)'
    ctx.fillStyle = bad ? 'rgba(248,113,113,0.08)' : 'rgba(249,115,22,0.12)'
    for (const L of towel.layers) {
      const neg = clip(worldPoly(L), n, c, true)
      if (!neg) continue
      pathOf(neg.map((p) => ap(R, p)))
      ctx.fill()
      ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([])
    }
    ctx.restore()
    for (const g of grasps) arrow(g, ap(R, g), bad ? 'rgba(248,113,113,0.9)' : '#f97316')
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    drawTable()
    if (!towel) return
    // Towel shadow.
    ctx.save()
    ctx.translate(3, 5)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    // One fill per layer: reflected layers wind the other way, so a single path would cancel out.
    for (const L of anim ? anim.kept : towel.layers) { pathOf(worldPoly(L)); ctx.fill() }
    ctx.restore()

    if (anim) {
      const f = animStep(now)
      if (anim) {
        for (const L of anim.kept) drawLayer(L)
        const k = Math.cos(f * Math.PI)
        const M = squash(anim.n, anim.c, k)
        const lift = Math.sin(f * Math.PI)
        // Shadow under the lifted flap.
        if (lift > 0.02) {
          ctx.save()
          ctx.translate(6 * lift, 12 * lift)
          ctx.fillStyle = `rgba(0,0,0,${0.25 * lift})`
          for (const L of anim.flap) { pathOf(L.poly.map((p) => ap(mul(M, L.m), p))); ctx.fill() }
          ctx.restore()
        }
        const order = k > 0 ? anim.flap : anim.flap.slice().reverse()
        for (const L of order) drawLayer(L, M, k)
      } else {
        for (const L of towel.layers) drawLayer(L)
      }
    } else {
      for (const L of towel.layers) drawLayer(L)
    }

    drawAim()
    if (state === 'grasp2' || state === 'aim') grasps.forEach((g, i) => drawGrasp(g, i ? 'R' : 'L'))
    if (state === 'grasp1' || state === 'grasp2') {
      // Pulse the towel's edge so it's clear where to click.
      const a = 0.35 + 0.25 * Math.sin(now / 250)
      ctx.strokeStyle = `rgba(34,211,238,${a})`
      ctx.lineWidth = 2
      pathOf(outline())
      ctx.stroke()
    }

    drawRobot()
    drawArm(0)
    drawArm(1)

    if (msg && now < msg.until) {
      const a = Math.min(1, (msg.until - now) / 300)
      ctx.globalAlpha = a
      ctx.font = '600 13px Inter, sans-serif'
      const tw = ctx.measureText(msg.text).width
      ctx.fillStyle = 'rgba(10,15,26,0.88)'
      ctx.beginPath(); ctx.roundRect(W / 2 - tw / 2 - 12, H * 0.2, tw + 24, 28, 8); ctx.fill()
      ctx.strokeStyle = 'rgba(249,115,22,0.6)'; ctx.lineWidth = 1; ctx.stroke()
      ctx.fillStyle = '#e6ebf4'
      ctx.textAlign = 'center'
      ctx.fillText(msg.text, W / 2, H * 0.2 + 18)
      ctx.globalAlpha = 1
    }
  }

  let lastScore = 0
  function tick(now) {
    requestAnimationFrame(tick)
    if (!visible || canvas.offsetParent === null) return
    if (!towel) resize() // the tab was just opened
    if (!towel) return
    draw(now)
    if (t0 && !tEnd && now - lastScore > 100) { updateScore(); lastScore = now }
  }

  new ResizeObserver(resize).observe(canvas)
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((e) => { visible = e[0].isIntersecting }).observe(canvas)
  }
  resize()
  requestAnimationFrame(tick)
  // For local testing only.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__fold = { get state() { return state }, get towel() { return towel }, outline, planFold, get grasps() { return grasps } }
  }
})()
