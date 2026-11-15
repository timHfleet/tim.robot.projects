// Hero robot: the two-arm mobile manipulator from my Robot Simulator, exported from the
// simulator as a glTF model and rendered live. The body turns toward the cursor, the
// head tracks it, the lift column "breathes", and Say hi makes the right arm wave.
// Callouts are pinned to the real joints by projecting them to the screen every frame.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const canvas = document.getElementById('robot3d')
const stage = canvas?.closest('.robot-stage')
const boot = document.getElementById('robot-boot')
const waveBtn = document.getElementById('robot-wave')
const callouts = [...document.querySelectorAll('#robot-callouts .callout')]
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// Joint axes of each arm in the simulator (shoulder pitch, shoulder roll, upper-arm twist,
// elbow, forearm twist, wrist pitch, wrist yaw), in each joint's own frame.
const AXES = {
  L: [[0, 0, 1], [1, 0, 0], [0, -1, 0], [0, 0, 1], [0, -1, 0], [0, 0, 1], [1, 0, 0]],
  R: [[0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 0], [0, 0, 1], [-1, 0, 0]],
}
// Tunable poses (radians) so the motion reads well from the hero camera.
const POSE = {
  waveUp: [0, 1.3, -1.57, 1.6, 0, 0, 0], // upper arm out to the side, twisted so the forearm points up
  waveSwing: 0.32, // elbow swing amplitude while waving (side to side, seen from the front)
}

function start() {
  if (!canvas || !stage) return
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
  } catch {
    stage.classList.add('no-webgl')
    return
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.55

  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50)

  // Lights: a soft key from the front, and cyan / violet rims from the beam behind.
  scene.add(new THREE.HemisphereLight('#9fb6ff', '#0a0f1a', 0.5))
  const key = new THREE.DirectionalLight('#ffffff', 1.6)
  key.position.set(1.5, 2.5, 3)
  const rimC = new THREE.DirectionalLight('#22d3ee', 3.2)
  rimC.position.set(-2.5, 2, -2)
  const rimV = new THREE.DirectionalLight('#a78bfa', 3.4)
  rimV.position.set(2.5, 2.2, -2)
  const top = new THREE.SpotLight('#c4f1ff', 18, 6, 0.42, 0.7, 1.4)
  top.position.set(0, 3.6, 0.2)
  scene.add(key, rimC, rimV, top, top.target)

  // Ground: a glowing disc where the beam lands, a soft contact shadow, and a scan ring.
  const discTex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const g = c.getContext('2d')
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128)
    grad.addColorStop(0, 'rgba(160,230,255,0.55)')
    grad.addColorStop(0.35, 'rgba(110,140,255,0.22)')
    grad.addColorStop(1, 'rgba(110,80,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 256, 256)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })()
  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    new THREE.MeshBasicMaterial({ map: discTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  disc.rotation.x = -Math.PI / 2
  disc.position.y = 0.002
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.42, 48),
    new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.45, depthWrite: false }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.scale.set(1.25, 0.8, 1)
  shadow.position.y = 0.003
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.98, 1, 96),
    new THREE.MeshBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.004
  scene.add(disc, shadow, ring)

  // The robot faces +x in the simulator; this group turns it to face the camera.
  const turn = new THREE.Group()
  scene.add(turn)

  const rig = { L: [], R: [], head: null, tilt: null, carriage: null, nodes: {} }
  let ready = false
  let height = 1.5

  const resize = () => {
    const w = stage.clientWidth
    const h = stage.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    frame()
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    setGround()
    needsRender = true
  }
  // Put the horizon line and the foot of the beam exactly where the robot stands.
  const setGround = () => {
    const heroEl = stage.closest('.hero2')
    if (!heroEl) return
    const p = new THREE.Vector3(0, 0, 0).project(camera)
    const y = stage.getBoundingClientRect().top - heroEl.getBoundingClientRect().top + ((1 - p.y) / 2) * stage.clientHeight
    heroEl.style.setProperty('--ground', `${Math.round(y)}px`)
  }
  // Fit the whole robot with some headroom; on narrow screens back off a little.
  const frame = () => {
    const narrow = stage.clientWidth < 520
    const dist = (height * (narrow ? 1.62 : 1.42)) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
    camera.position.set(0, height * 0.62, dist)
    camera.lookAt(0, height * 0.5, 0)
  }

  new GLTFLoader().load(
    'assets/robot.glb',
    (gltf) => {
      const model = gltf.scene
      model.rotation.y = -Math.PI / 2
      turn.add(model)
      turn.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(model)
      height = box.max.y - box.min.y
      const c = box.getCenter(new THREE.Vector3())
      model.position.x -= c.x
      model.position.z -= c.z
      model.position.y -= box.min.y
      model.traverse((o) => {
        if (o.name) rig.nodes[o.name] = o
        if (o.isMesh && o.material) {
          o.material.envMapIntensity = 1
          // Status LEDs and light strips glow a touch more in the dark hero.
          if (o.material.emissive && o.material.emissiveIntensity > 0.2) o.material.emissiveIntensity *= 1.4
        }
      })
      for (const s of ['L', 'R']) {
        for (let i = 0; i < 7; i++) {
          const j = rig.nodes[`${s}_j${i}`]
          if (!j) continue
          rig[s].push({ obj: j, base: j.quaternion.clone(), axis: new THREE.Vector3(...AXES[s][i]), angle: 0 })
        }
      }
      rig.head = rig.nodes.head_pan ? { obj: rig.nodes.head_pan, base: rig.nodes.head_pan.quaternion.clone() } : null
      rig.tilt = rig.nodes.head_tilt ? { obj: rig.nodes.head_tilt, base: rig.nodes.head_tilt.quaternion.clone() } : null
      rig.carriage = rig.nodes.carriage ? { obj: rig.nodes.carriage, y: rig.nodes.carriage.position.y } : null
      ready = true
      resize()
      stage.classList.add('loaded')
      boot?.remove()
      ring.userData.t0 = performance.now()
    },
    undefined,
    () => {
      stage.classList.add('no-webgl')
    },
  )

  // --- input ---------------------------------------------------------------------------
  const pointer = { x: 0, y: 0, active: false }
  const hero = stage.closest('.hero2') || document.body
  hero.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect()
    pointer.x = THREE.MathUtils.clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1.6, 1.6)
    pointer.y = THREE.MathUtils.clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1.6, 1.6)
    pointer.active = true
    needsRender = true
  })
  hero.addEventListener('pointerleave', () => {
    pointer.active = false
  })
  let waveT = -1
  waveBtn?.addEventListener('click', () => {
    waveT = 0
    needsRender = true
    ring.userData.t0 = performance.now()
  })
  canvas.addEventListener('click', () => waveBtn?.click())

  // --- animation -----------------------------------------------------------------------
  const q = new THREE.Quaternion()
  const setJoint = (j, a) => {
    j.angle = a
    j.obj.quaternion.copy(j.base).multiply(q.setFromAxisAngle(j.axis, a))
  }
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2)
  let yaw = 0
  let panA = 0
  let tiltA = 0
  let last = performance.now()
  let visible = true
  let needsRender = true

  const v = new THREE.Vector3()
  const placeCallouts = () => {
    if (!ready) return
    const w = stage.clientWidth
    const h = stage.clientHeight
    for (const el of callouts) {
      const n = rig.nodes[el.dataset.node]
      if (!n) continue
      n.getWorldPosition(v).project(camera)
      el.style.left = `${((v.x + 1) / 2) * w}px`
      el.style.top = `${((1 - v.y) / 2) * h}px`
    }
  }

  function tick(now) {
    requestAnimationFrame(tick)
    if (!visible || !ready) return
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const t = now / 1000
    const animate = !reduce
    if (!animate && !needsRender && waveT < 0) return

    // Body turns toward the cursor (or drifts slowly when there is none); the head leads.
    const targetYaw = pointer.active ? pointer.x * 0.55 : animate ? Math.sin(t * 0.35) * 0.35 : 0
    yaw += (targetYaw - yaw) * Math.min(1, dt * 2.2)
    turn.rotation.y = yaw
    const targetPan = pointer.active ? pointer.x * 0.5 : animate ? Math.sin(t * 0.6 + 1) * 0.25 : 0
    const targetTilt = pointer.active ? -pointer.y * 0.35 : 0
    panA += (targetPan - panA) * Math.min(1, dt * 5)
    tiltA += (targetTilt - tiltA) * Math.min(1, dt * 5)
    if (rig.head) rig.head.obj.quaternion.copy(rig.head.base).multiply(q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), panA))
    if (rig.tilt) rig.tilt.obj.quaternion.copy(rig.tilt.base).multiply(q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), tiltA))

    // Idle: the lift column breathes and the arms sway a little, out of phase.
    if (rig.carriage) rig.carriage.obj.position.y = rig.carriage.y + (animate ? Math.sin(t * 1.3) * 0.006 : 0)
    const sway = animate ? 1 : 0
    rig.L.length && setJoint(rig.L[0], Math.sin(t * 0.9) * 0.05 * sway)
    rig.L.length && setJoint(rig.L[3], 0.12 + Math.sin(t * 0.9 + 0.6) * 0.06 * sway)

    // Right arm: idle sway, or a wave (raise, swing three times, lower) over 3.2 s.
    if (rig.R.length) {
      let blend = 0
      let swing = 0
      if (waveT >= 0) {
        waveT += dt
        const T = 3.2
        blend = waveT < 0.7 ? ease(waveT / 0.7) : waveT > T - 0.7 ? ease(Math.max(0, (T - waveT) / 0.7)) : 1
        swing = Math.sin((waveT - 0.7) * 7.5) * POSE.waveSwing * (waveT > 0.7 && waveT < T - 0.7 ? 1 : 0)
        if (waveT >= T) waveT = -1
      }
      for (let i = 0; i < 7; i++) {
        const idle = i === 0 ? Math.sin(t * 0.9 + 2) * 0.05 * sway : i === 3 ? 0.12 + Math.sin(t * 0.9 + 2.6) * 0.06 * sway : 0
        let a = idle * (1 - blend) + POSE.waveUp[i] * blend
        if (i === 3) a += swing
        if (i === 5) a += swing * 0.5
        setJoint(rig.R[i], a)
      }
    }

    // A scan ring sweeps out across the floor on load and on every wave.
    const rt = (now - (ring.userData.t0 || -1e9)) / 1000
    if (rt < 1.6) {
      const k = rt / 1.6
      ring.scale.setScalar(0.25 + k * 1.1)
      ring.material.opacity = (1 - k) * 0.8
    } else ring.material.opacity = 0
    disc.material.opacity = 0.85 + (animate ? Math.sin(t * 2) * 0.15 : 0)

    renderer.render(scene, camera)
    placeCallouts()
    needsRender = false
  }

  new ResizeObserver(resize).observe(stage)
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((e) => {
      visible = e[0].isIntersecting
      last = performance.now()
    }).observe(stage)
  }
  resize()
  requestAnimationFrame(tick)
  if (location.hostname === 'localhost') window.__hero = { rig, POSE, camera, turn, scene, renderer, setJoint }
}

start()
