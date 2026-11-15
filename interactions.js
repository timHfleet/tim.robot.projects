// Page interactions: scroll reveal, count-up stats, tilting project cards, the inline
// simulator demo, the active-section nav with a progress bar, and the skill-card glow.
// Everything is optional decoration: the page reads fine without JavaScript, and motion is
// skipped when the visitor asks for reduced motion.
(() => {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const fine = window.matchMedia('(pointer: fine)').matches

  // --- Reveal sections and cards as they scroll into view ---------------------------
  const revealables = document.querySelectorAll('.section-head, .project, .timeline > li, .skill-card, .stats > div, .contact')
  if (!reduce && 'IntersectionObserver' in window) {
    revealables.forEach((el, i) => {
      el.classList.add('reveal')
      el.style.setProperty('--d', `${(i % 4) * 70}ms`)
    })
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          e.target.classList.add('in')
          io.unobserve(e.target)
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    )
    revealables.forEach((el) => io.observe(el))
  }

  // --- Count the highlight numbers up when they appear ------------------------------
  const nums = document.querySelectorAll('.stats .num')
  const countUp = (el) => {
    const m = el.textContent.match(/^(\d+)(.*)$/)
    if (!m) return
    const target = +m[1]
    const suffix = m[2]
    const t0 = performance.now()
    const dur = 1100
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur)
      const e = 1 - Math.pow(1 - k, 3)
      el.textContent = `${Math.round(target * e)}${suffix}`
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        countUp(e.target)
        io.unobserve(e.target)
      }
    }, { threshold: 0.6 })
    nums.forEach((n) => io.observe(n))
  }

  // --- Project screenshots tilt toward the cursor -----------------------------------
  if (fine && !reduce) {
    document.querySelectorAll('.project .shot').forEach((shot) => {
      shot.addEventListener('pointermove', (e) => {
        const r = shot.getBoundingClientRect()
        const x = (e.clientX - r.left) / r.width - 0.5
        const y = (e.clientY - r.top) / r.height - 0.5
        shot.style.transform = `perspective(900px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg)`
        shot.style.setProperty('--gx', `${(x + 0.5) * 100}%`)
        shot.style.setProperty('--gy', `${(y + 0.5) * 100}%`)
      })
      shot.addEventListener('pointerleave', () => {
        shot.style.transform = ''
      })
    })
  }

  // --- "Try it here": load the live simulator inside the project card ---------------
  document.querySelectorAll('[data-demo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.project')
      const shot = card?.querySelector('.shot')
      if (!shot) return
      if (card.classList.contains('demo-on')) {
        card.querySelector('.demo-frame')?.remove()
        card.classList.remove('demo-on')
        btn.textContent = 'Try it here'
        return
      }
      const wrap = document.createElement('div')
      wrap.className = 'demo-frame'
      wrap.innerHTML = '<p class="demo-wait">Waking up the demo server (free host: up to a minute)…</p>'
      const frame = document.createElement('iframe')
      frame.src = btn.dataset.demo
      frame.title = 'Live demo'
      frame.loading = 'lazy'
      frame.allow = 'fullscreen'
      frame.addEventListener('load', () => wrap.querySelector('.demo-wait')?.remove())
      wrap.appendChild(frame)
      shot.after(wrap)
      card.classList.add('demo-on')
      btn.textContent = 'Close demo'
    })
  })

  // --- Nav: highlight the section on screen, and a reading-progress bar -------------
  const links = [...document.querySelectorAll('.nav nav a[href^="#"]')]
  const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean)
  const bar = document.createElement('div')
  bar.className = 'progress'
  document.querySelector('.nav')?.appendChild(bar)
  const onScroll = () => {
    const h = document.documentElement
    const k = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)
    bar.style.transform = `scaleX(${k})`
    let current = null
    for (const s of sections) if (s.getBoundingClientRect().top < window.innerHeight * 0.35) current = s
    for (const a of links) a.classList.toggle('active', !!current && a.getAttribute('href') === `#${current.id}`)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  // --- Skill cards: a soft glow that follows the cursor -----------------------------
  if (fine) {
    document.querySelectorAll('.skill-card').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect()
        card.style.setProperty('--mx', `${e.clientX - r.left}px`)
        card.style.setProperty('--my', `${e.clientY - r.top}px`)
      })
    })
  }

  // --- Play: switch between the mini games --------------------------------------------
  const tabs = [...document.querySelectorAll('.game-tabs [role="tab"]')]
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on
    }
    // The Jenga canvas sizes itself on window resize; nudge it if the window changed while hidden.
    const arm = document.getElementById('arm')
    if (tab.id === 'tab-jenga' && arm && Math.abs(arm.width - Math.round(arm.getBoundingClientRect().width * Math.min(window.devicePixelRatio || 1, 2))) > 2) {
      window.dispatchEvent(new Event('resize'))
    }
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t))
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
      select(next)
      next.focus()
    })
  })
})()
