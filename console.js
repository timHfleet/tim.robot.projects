// Hero background stars and the fleet console mock under the robot. The console runs on
// simulated data (it says so on the card); it shows the kind of operations tool I build.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const hero = document.querySelector('.hero2')
  if (!hero) return
  let heroVisible = true
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((e) => { heroVisible = e[0].isIntersecting }).observe(hero)
  }

  // --- Stars drifting up through the dark, brighter near the beam --------------------
  const stars = document.getElementById('stars')
  if (stars) {
    const g = stars.getContext('2d')
    let pts = []
    let W = 0
    let H = 0
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const size = () => {
      W = stars.clientWidth
      H = stars.clientHeight
      stars.width = W * dpr
      stars.height = H * dpr
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round((W * H) / 9000)
      pts = Array.from({ length: n }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.2 + 0.2, v: Math.random() * 6 + 2, p: Math.random() * 6.28 }))
    }
    size()
    new ResizeObserver(size).observe(stars)
    const draw = (now) => {
      if (!reduce) requestAnimationFrame(draw)
      if (!heroVisible && !reduce) return
      g.clearRect(0, 0, W, H)
      const t = now / 1000
      for (const s of pts) {
        if (!reduce) {
          s.y -= s.v / 60
          if (s.y < -2) { s.y = H + 2; s.x = Math.random() * W }
        }
        const nearBeam = Math.max(0, 1 - Math.abs(s.x - W / 2) / (W * 0.18))
        const a = 0.25 + 0.35 * Math.sin(t * 1.5 + s.p) ** 2 + nearBeam * 0.4
        g.fillStyle = nearBeam > 0.2 ? `rgba(165,243,252,${a})` : `rgba(200,210,255,${a * 0.8})`
        g.beginPath()
        g.arc(s.x, s.y, s.r + nearBeam * 0.6, 0, Math.PI * 2)
        g.fill()
      }
    }
    requestAnimationFrame(draw)
  }

  // --- Console: tilts back in 3D and flattens as it scrolls into view -----------------
  const wrap = document.querySelector('.console-wrap')
  const card = document.getElementById('console')
  if (wrap && card && !reduce) {
    const onScroll = () => {
      const r = wrap.getBoundingClientRect()
      const k = Math.min(1, Math.max(0, (window.innerHeight - r.top) / (window.innerHeight * 0.75)))
      card.style.transform = `perspective(1400px) rotateX(${(1 - k) * 22}deg) scale(${0.92 + k * 0.08})`
      card.style.opacity = String(0.55 + k * 0.45)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
  }

  // --- Throughput sparkline ----------------------------------------------------------
  const spark = document.getElementById('spark')
  const series = Array.from({ length: 48 }, (_, i) => 18 + Math.sin(i / 4) * 4 + Math.random() * 3)
  const drawSpark = () => {
    if (!spark) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = spark.clientWidth
    const h = spark.clientHeight
    if (spark.width !== Math.round(w * dpr)) { spark.width = w * dpr; spark.height = h * dpr }
    const g = spark.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const max = 30
    const x = (i) => (i / (series.length - 1)) * w
    const y = (v) => h - 8 - (v / max) * (h - 16)
    g.strokeStyle = 'rgba(148,163,184,0.12)'
    g.lineWidth = 1
    for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(0, (h / 4) * k); g.lineTo(w, (h / 4) * k); g.stroke() }
    const grad = g.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, 'rgba(34,211,238,0.35)')
    grad.addColorStop(1, 'rgba(34,211,238,0)')
    g.beginPath()
    series.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
    g.lineTo(w, h); g.lineTo(0, h); g.closePath()
    g.fillStyle = grad
    g.fill()
    g.beginPath()
    series.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
    g.strokeStyle = '#22d3ee'
    g.lineWidth = 2
    g.stroke()
    const lx = x(series.length - 1)
    const ly = y(series.at(-1))
    g.fillStyle = '#22d3ee'
    g.beginPath(); g.arc(lx - 2, ly, 3.5, 0, Math.PI * 2); g.fill()
    g.fillStyle = 'rgba(34,211,238,0.25)'
    g.beginPath(); g.arc(lx - 2, ly, 8, 0, Math.PI * 2); g.fill()
  }
  drawSpark()
  window.addEventListener('resize', drawSpark)

  // --- Event log and KPIs ------------------------------------------------------------
  const log = document.getElementById('log')
  const robots = ['HMN-07', 'HMN-12', 'HMN-23', 'HMN-31', 'HMN-44', 'HMN-58', 'HMN-63', 'HMN-90']
  const events = [
    ['ok', 'grasp succeeded · towel corner'],
    ['ok', 'fold complete · 2 folds'],
    ['ok', 'task done · stack towel'],
    ['info', 'path planned · 3.2 m to laundry'],
    ['info', 'wrist cam · corner detected'],
    ['warn', 'battery 21% · queued for dock'],
    ['ok', 'firmware 4.2.1 · verified'],
    ['info', 'IK solved · 7 joints in limits'],
    ['warn', 'regrasp · cloth slipped'],
    ['ok', 'dishwasher rack loaded'],
    ['warn', 'base cam · table 42 cm ahead · slowing'],
    ['info', 'base cams · 360° clear'],
  ]
  const pad = (n) => String(n).padStart(2, '0')
  const addLog = () => {
    if (!log) return
    const [lvl, msg] = events[Math.floor(Math.random() * events.length)]
    const d = new Date()
    const li = document.createElement('li')
    li.className = `lv-${lvl}`
    li.innerHTML = `<time>${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</time><b>${robots[Math.floor(Math.random() * robots.length)]}</b><span></span>`
    li.querySelector('span').textContent = msg
    log.prepend(li)
    while (log.children.length > 7) log.lastElementChild.remove()
  }
  for (let i = 0; i < 6; i++) addLog()

  const kTasks = document.querySelector('[data-kpi="tasks"]')
  const kBatt = document.querySelector('[data-kpi="batt"]')
  let tasks = 1284
  let batt = 82
  if (!reduce) {
    setInterval(() => {
      if (!heroVisible || document.hidden) return
      addLog()
      tasks += 1 + Math.floor(Math.random() * 3)
      if (kTasks) kTasks.textContent = tasks.toLocaleString('en-US')
      batt = Math.max(70, Math.min(90, batt + (Math.random() < 0.5 ? -1 : 1)))
      if (kBatt) kBatt.textContent = `${batt}%`
      series.shift()
      series.push(Math.max(8, Math.min(28, series.at(-1) + (Math.random() - 0.48) * 4)))
      drawSpark()
    }, 1600)
  }
})()
