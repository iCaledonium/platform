import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { buildLanding } from "./Landing.js";
import { loadDisplay, applyDisplay, DISPLAY_DEFAULTS } from "./exploreDisplay.js";
import styles from "./Scene.module.css";

// ── DoorScene3D ──────────────────────────────────────────────────────────────
//
// Session 152 — you are outside, in a stairwell, at a door.
//
// The scene this replaces opened on a 140px circular photograph of the person
// behind the closed door, with "Knocking at the door…" underneath. The one face
// unavailable to you while you stand outside knocking is hers, and showing it
// gave away the answer before the question had been asked. Her four possible
// answers — open, ignore, pretend to be out, text you instead — all looked the
// same: the same portrait, a different caption.
//
// Here the door carries them. It opens, or the light goes out, or your phone
// goes. Her face arrives once, in the gap, and only if she lets you in.

const SIM = "https://anima.simulator.ngrok.dev";

// Session 152 kept her out of the doorway because glb_url was a bare body —
// no clothes, no hair — and "flip this to true when deploy exports a dressed
// model" was the condition. Session 153: it does. Deploy now ships
// runtime_<worldActorId>.glb — wardrobe baked in, morphs folded into the
// vertices, garments rebound to her skeleton, idle+walk clips — and
// KnockActorDoor passes it as glbUrl (editable glb_url remains the fallback
// for actors deployed before runtime models existed).
const SHOW_AVATAR = true;

export default function DoorScene3D({ world, user, sceneData, actorName, actorId, glbUrl, onLeave }) {
  const { location, encounter_id } = sceneData;

  const host      = useRef(null);
  const api       = useRef({});      // three objects, kept out of React state
  const [phase,     setPhase]     = useState(encounter_id ? "knocking" : "empty");
  const [decision,  setDecision]  = useState(null);
  const [narrative, setNarrative] = useState("");
  const [loadPct,   setLoadPct]   = useState(null);
  const [ready,     setReady]    = useState(false);   // everything is on screen

  // With the encounter model on a host that is currently down, a real knock can
  // only ever time out — so the scene can be driven by hand to look at it.
  // ?rehearse=open | ignore | text | error
  const rehearse = new URLSearchParams(window.location.search).get("rehearse");

  // ── the room ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070605);
    scene.fog = new THREE.Fog(0x070605, 7, 15);

    // A 2.07m door needs about 2.9m of frame to breathe, and at 50 degrees
    // vertical that means standing 2.8m back. The first pass used 42 degrees at
    // 1.6m, which is close enough to touch the handle: the leaf filled the frame
    // top to bottom with no floor, no mat and no hall, and a dark paint read as
    // a black rectangle because there was nothing else in shot to judge it by.
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.05, 60);
    // Eye height, and a touch off-centre — standing square to a door is a lift,
    // not a person.
    camera.position.set(0.2, 1.62, 2.82);
    camera.lookAt(0, 1.14, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    // The three lights the 3D character tab configures. Created at its defaults
    // and then set from whatever the user saved, so the flat behind this door
    // is lit exactly like the flat on that tab.
    const ambient = new THREE.HemisphereLight(0xffffff, 0x3a352c, DISPLAY_DEFAULTS.ambientIntensity);
    const key = new THREE.DirectionalLight(0xffffff, DISPLAY_DEFAULTS.keyIntensity);
    const rim = new THREE.DirectionalLight(0xdce6f2, DISPLAY_DEFAULTS.rimIntensity);
    rim.position.set(-2.6, 2.2, -3.4);
    scene.add(ambient, key, rim);

    const landing = buildLanding(scene, {
      placeId: location?.place_id || location?.id || "",
      surname: (actorName || "").split(" ").slice(-1)[0],
    });
    console.log("[door]", landing.paint, "·", landing.panels, "panels ·",
                landing.brass ? "brass" : "steel");

    api.current = { scene, camera, renderer, landing, el, clock: new THREE.Clock(),
                    abort: new AbortController(), ambient, key, rim };
    // Reaching into a running scene beats guessing at it from a screenshot.
    window.__door = api.current;

    // Session 152 — knocking and loading happen at the same time.
    //
    // The flat used to wait for her answer, which meant the interesting case
    // paid for it twice: she opens, and only then does ten megabytes start
    // moving. A knock takes seconds of dead time either way, so it buys the
    // load. If she does not open, the download is cancelled and thrown away
    // — the cheap outcome should cost nothing.
    loadFlat();
    // Session 153 — her download starts with the knock, not with the open.
    // At 92MB waiting for the decision was the right trade; at 26.7MB the
    // ghost it produced (a door swinging open onto an empty gap while she
    // streamed in) is worse than the bytes a refusal throws away. abandon()
    // cancels this fetch the same as the flat's if she doesn't open.
    loadHer();
    loadDisplay({ signal: api.current.abort.signal }).then(d => {
      const a = api.current;
      if (!a.scene) return;
      a.display = d;
      applyDisplay(d, { renderer: a.renderer, scene: a.scene,
                        key: a.key, ambient: a.ambient, rim: a.rim });
      console.log("[door] lighting from your saved settings:", d);
    });

    const onResize = () => {
      if (!el.clientWidth) return;
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);

    let raf, t = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dt = api.current.clock.getDelta();
      t += dt;

      // The bulb is old and the wiring is worse.
      const b = landing.bulb;
      if (b) b.intensity = 30 + Math.sin(t * 11) * 0.7 + Math.sin(t * 3.1) * 0.45;

      const s = api.current.swing;
      if (s && s.pivot) {
        s.now += (s.to - s.now) * Math.min(1, dt * 2.2);
        s.pivot.rotation.y = s.dir * s.now;
      }
      api.current.mixer?.update(dt);
      const c = api.current.dolly;
      if (c) {
        camera.position.lerp(c.pos, Math.min(1, dt * 1.1));
        camera.lookAt(c.at);
      }
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => {
          Object.values(m).forEach(v => v?.isTexture && v.dispose());
          m.dispose();
        });
      });
      el.removeChild(renderer.domElement);
    };
  }, [location?.place_id, actorName]);

  // ── knock, and wait ───────────────────────────────────────────────────────
  useEffect(() => {
    if (rehearse) {
      const map = { open: "open_door", ignore: "ignore", text: "send_text" };
      const t = setTimeout(() => {
        if (rehearse === "error") { setPhase("error"); return; }
        setNarrative({
          open:   "The lock turns. She looks out, then wider.",
          ignore: "The light under the door goes out.",
          text:   "Nothing. Then your phone goes off in your pocket.",
        }[rehearse] || "");
        setDecision(map[rehearse] || null);
        setPhase("answered");
      }, 2600);
      return () => clearTimeout(t);
    }

    if (!encounter_id) return;
    let dead = false;
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/worlds/${world.id}/encounter/${encounter_id}`, { credentials: "include" });
        if (!r.ok) return;
        const d = await r.json();
        if (dead) return;
        if (d.narrative) setNarrative(d.narrative);
        if (d.decision) { setDecision(d.decision); setPhase("answered"); clearInterval(poll); }
        else if (d.phase === "ended") {
          // Ended with nothing decided is not her being rude — it is the world
          // failing to think. Those are different pictures.
          setPhase("error"); clearInterval(poll);
        } else if (d.phase === "perceiving") setPhase("heard");
      } catch { /* keep waiting */ }
    }, 1400);
    return () => { dead = true; clearInterval(poll); };
  }, [encounter_id, world?.id, rehearse]);

  // ── what the door does about it ───────────────────────────────────────────
  useEffect(() => {
    const a = api.current;
    if (!a.landing) return;
    const { landing } = a;

    if (phase === "heard") {
      landing.under.material.opacity = 0.85;   // she's up
    }

    if (phase === "error") {
      landing.under.material.opacity = 0;
      abandon();
    }

    if (phase === "answered") {
      if (decision === "open_door") {
        openDoor();
      } else if (decision === "ignore" || decision === "pretend_away") {
        // The worst outcome gets the least motion. Nothing opens; the light
        // just stops — and whatever is still coming down the wire stops too.
        abandon();
        setTimeout(() => { landing.under.material.opacity = 0; }, 1100);
      } else if (decision === "send_text") {
        landing.under.material.opacity = 0.5;
      }
    }
  }, [phase, decision]);

  function gltfLoader() {
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    return loader;
  }

  // ── the flat, and the door it came with ───────────────────────────────────
  //
  // Loaded while she decides. Ten megabytes and a knock takes seconds, so the
  // dead time pays for itself — and it has to be here rather than on open,
  // because the door you are standing in front of is the one out of this file.
  function loadFlat() {
    const a = api.current;
    if (!a.scene || a.flatLoading) return;
    a.flatLoading = true;
    const loader = gltfLoader();

    // The flat, hung on the doorway by its own front door.
    //
    // Centring it by bounding box put the doorway wherever the middle of the
    // model happened to fall — for the studio that is the window wall, so the
    // door opened onto the balcony end and you stood looking the length of the
    // flat from the wrong side. Where the front door is cannot be worked out
    // from the file (see homes.json), so it is declared, and this code reads the
    // declaration rather than the mesh.
    const HOME = "studio_apartment";
    Promise.all([
      fetch("/media/homes/homes.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
      new Promise((ok, no) => loader.load(`/media/homes/${HOME}.glb`, ok, undefined, no)),
    ]).then(([manifest, gltf]) => {
      const home = gltf.scene;
      const spec = manifest?.[HOME];

      home.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });

      if (spec?.door && spec?.facing) {
        // Turn the flat until its door faces out at you, then slide it so that
        // door sits in this doorway.
        const f = new THREE.Vector3(...spec.facing).setY(0).normalize();
        home.rotation.y = -Math.atan2(f.x, f.z);
        home.position.set(0, 0, 0);
        home.updateMatrixWorld(true);

        const d = new THREE.Vector3(...spec.door)
          .applyEuler(new THREE.Euler(0, home.rotation.y, 0));
        // Level with the door's own threshold, not with the lowest point in the
        // file. Using the shell minimum lifted the flat 22cm — the balcony lip
        // sits below floor level — and left her front door hanging above our
        // landing with daylight under it.
        home.position.set(-d.x, -d.y, -d.z);
        // Box3.setFromObject refreshes an object and its descendants but not its
        // ancestors, so measuring the leaf now without this would measure it
        // against the flat's previous position — which is how the first attempt
        // hung her door five metres behind the camera and left the doorway
        // showing an empty black rectangle.
        home.updateMatrixWorld(true);

        // Their door leaf now occupies our doorway — ours is the one that
        // swings, so theirs goes. Matched on the declared name rather than
        // guessed, because guessing is what put a refrigerator in the running
        // last time.
        for (const name of spec.hide || []) {
          home.traverse(o => {
            if (o.name && o.name.toLowerCase().startsWith(name.toLowerCase())) o.visible = false;
          });
        }
      } else {
        // No entry for this mesh. Centre it and say so — looking into a flat
        // from the wrong end still looks like a flat, and it beats not opening.
        console.warn(`[door] no door declared for ${HOME} — centring the flat instead`);
        const bb = new THREE.Box3().setFromObject(home);
        const c = bb.getCenter(new THREE.Vector3());
        home.position.set(-c.x, -bb.min.y, -c.z - 1.9);
      }

      a.scene.add(home);
      a.home = home;

      // Adopt her door. Object3D.attach keeps the leaf exactly where it is
      // while changing who moves it, so a pivot dropped on the hinge edge turns
      // a modelled door into a working one without touching its geometry.
      const leaf = spec?.leaf && home.getObjectByName(spec.leaf);
      if (leaf) {
        const lb = new THREE.Box3().setFromObject(leaf);
        const left = spec.hinge !== "right";
        const pivot = new THREE.Group();
        pivot.position.set(left ? lb.min.x : lb.max.x, lb.min.y, (lb.min.z + lb.max.z) / 2);
        a.scene.add(pivot);
        pivot.attach(leaf);
        a.leafPivot = pivot;
        a.leafDir = left ? -1 : 1;

        // Her leaf swings; the hall side of it is ours.
        //
        // The outward face renders black, and it took three wrong theories to
        // find out why. Not the lighting: it is KHR_materials_unlit, so no lamp
        // was ever going to touch it, and rehanging the texture on a lit
        // material made it worse. Not the texture: its pixels measure
        // [216, 213, 208], almost white. Not the placement: strip the map and
        // the same geometry renders pure white, in the doorway, at the right
        // height.
        //
        // The UVs on that one face point at an unpainted corner of the atlas —
        // because this is an interior model and the outside of the front door
        // is a surface nobody standing in the flat can see. It was never
        // painted, and no home mesh bought off a shelf will have painted it.
        //
        // So the built door earns its keep after all, as a skin: hung a
        // centimetre proud on the hall side of her leaf and parented to the
        // same pivot, so it carries the paint, the panels, the handle and her
        // nameplate while everything behind it — the swing, the inside face,
        // the frame — is the flat's own.
        leaf.traverse(o => { if (o.isMesh) o.castShadow = false; });

        const skin = a.landing.hinge;
        skin.visible = true;
        skin.position.set(pivot.position.x, pivot.position.y, pivot.position.z + 0.062);
        pivot.attach(skin);
        console.log(`[door] swinging ${spec.leaf} from the ${left ? "left" : "right"}`);
      } else {
        // No door in the file at all. Ours does the whole job.
        a.landing.hinge.visible = true;
        a.leafPivot = a.landing.hinge;
        a.leafDir = -1;
        console.log("[door] no leaf in the mesh — using the built door");
      }
      a.landing.blank.visible = false;
      if (a.pendingOpen) openDoor();

      // Light from inside, past her, into the hall.
      const warm = new THREE.PointLight(0xffcf9a, 16, 10, 2);
      warm.position.set(0, 1.95, -2.4);
      warm.visible = false;
      a.scene.add(warm);
      a.warm = warm;
    }).catch(e => {
      console.warn("[door] flat failed", e);
      // Still a door to knock on, just nothing behind it.
      a.landing.hinge.visible = true;
      a.landing.blank.visible = false;
      a.leafPivot = a.landing.hinge;
      a.leafDir = -1;
      if (a.pendingOpen) openDoor();
    });

    void 0;
  }

  // Her. Fetched in parallel with the knock decision (both fire on mount) and
  // reported honestly while it comes. The runtime model is ~26 MB and carries
  // her real solved height plus idle/walk clips. Fetched by hand rather than
  // through loader.load so a refusal can abort it mid-stream — GLTFLoader has
  // no cancel of its own.
  async function loadHer() {
    const a = api.current;
    if (!SHOW_AVATAR || !glbUrl || a.herLoading) return;
    a.herLoading = true;
    a.herAbort = new AbortController();
    setLoadPct(0);
    try {
      const res = await fetch(glbUrl, { credentials: "include", signal: a.herAbort.signal });
      if (!res.ok) throw new Error(`avatar fetch ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.byteLength;
        if (total) setLoadPct(Math.round((got / total) * 100));
      }
      const buf = new Uint8Array(got);
      { let off = 0; for (const c of chunks) { buf.set(c, off); off += c.byteLength; } }
      if (a.abandoned) return;   // she said no while the bytes were coming
      const gltf = await new Promise((ok, no) => gltfLoader().parse(buf.buffer, "", ok, no));
      if (a.abandoned) return;
      setLoadPct(null);
      const her = gltf.scene;
      const bb = new THREE.Box3().setFromObject(her);
      const h = bb.max.y - bb.min.y;
      // The runtime model is built at her real height — rescale only if the
      // asset is in obviously wrong units, not to normalize a person.
      if (h > 0.1 && (h < 1.2 || h > 2.2)) her.scale.setScalar(1.68 / h);
      const bb2 = new THREE.Box3().setFromObject(her);
      const c2 = bb2.getCenter(new THREE.Vector3());
      // In the gap, a pace inside, turned slightly towards you. Added now,
      // behind the still-closed leaf, so the door only ever opens onto her.
      her.position.set(0.1 - c2.x, -bb2.min.y, -0.55 - c2.z);
      her.rotation.y = -0.28;   // towards the hall, not away from it
      her.traverse(o => { if (o.isMesh) o.castShadow = true; });
      a.scene.add(her);
      a.her = her;
      // She stands in the gap, breathing — the runtime clips include idle.
      const idle = (gltf.animations || []).find(c => c.name === "idle") || (gltf.animations || [])[0];
      if (idle) {
        a.mixer = new THREE.AnimationMixer(her);
        a.mixer.clipAction(idle).play();
      }
      a.herReady = true;
      if (a.pendingOpen) openDoor();
      if (a.doorOpen) setReady(true);
    } catch (e) {
      setLoadPct(null);
      if (e?.name !== "AbortError") {
        console.warn("[door] avatar failed", e);
        // The door still opens — onto the gap, honestly — rather than never.
        a.herFailed = true;
        if (a.pendingOpen) openDoor();
      }
    }
  }

  // Nobody is coming. Cancel what is in flight and drop what already arrived —
  // there is no second act to keep it for, and it is the largest thing on the
  // page.
  function abandon() {
    const a = api.current;
    if (!a || a.abandoned) return;
    a.abandoned = true;
    a.abort?.abort();
    a.herAbort?.abort();
    if (a.her) {
      a.mixer = null;
      a.scene.remove(a.her);
      a.her.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => {
          Object.values(m).forEach(v => v?.isTexture && v.dispose());
          m.dispose();
        });
      });
      a.her = null;
    }
    if (a.home) {
      a.scene.remove(a.home);
      a.home.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach(m => {
          Object.values(m).forEach(v => v?.isTexture && v.dispose());
          m.dispose();
        });
      });
      a.home = null;
    }
    setReady(false);
    console.log("[door] she isn't opening — load abandoned");
  }

  function openDoor() {
    const a = api.current;
    if (!a.landing) return;
    if (!a.leafPivot) { a.pendingOpen = true; return; }   // the flat is still coming
    // Session 153 — and she has to be standing in it before it swings. Her
    // download started with the knock; if the decision beat the bytes, hold
    // the door and let the UI report the honest wait. A failed avatar load
    // sets herFailed and the door opens onto the gap rather than never.
    const herExpected = SHOW_AVATAR && glbUrl;
    if (herExpected && !a.herReady && !a.herFailed) { a.pendingOpen = true; return; }
    a.pendingOpen = false;
    a.doorOpen = true;
    a.landing.under.material.opacity = 0;                 // the gap is the light now
    if (a.warm) a.warm.visible = true;
    a.swing = { now: 0, to: 1.16, pivot: a.leafPivot, dir: a.leafDir };   // ~66°
    setReady(true);
    // Step to the threshold. Not through it — she has not asked you in yet.
    a.dolly = { pos: new THREE.Vector3(0.06, 1.62, 1.24), at: new THREE.Vector3(0, 1.2, -0.8) };
  }

  const timeStr = new Date().toLocaleTimeString("sv-SE",
    { hour: "2-digit", minute: "2-digit", timeZone: world?.timezone || "Europe/Stockholm" });

  const said = {
    knocking: "You knock.",
    heard:    "A light goes on under the door.",
    error:    "The world isn't answering. Nothing to do with her.",
    empty:    "Nobody lives here.",
  }[phase] || narrative || "";

  return (
    <div className={styles.scene}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.locationName}>{location?.name}</span>
          {location?.area && <span className={styles.locationArea}>{location.area}</span>}
        </div>
        <div className={styles.headerRight}>
          <span className={styles.time}>{timeStr}</span>
          <button className={styles.leaveBtn} onClick={onLeave}>Leave</button>
        </div>
      </div>

      <div ref={host} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0, padding: "26px 24px 24px",
          background: "linear-gradient(transparent, rgba(6,5,4,.92) 46%)", pointerEvents: "none",
        }}>
          <p style={{
            fontFamily: "'Cormorant Garamond',serif", fontStyle: "italic", fontSize: 16,
            color: "rgba(255,255,255,.74)", margin: "0 auto", maxWidth: 520, textAlign: "center",
            lineHeight: 1.5, minHeight: 24,
          }}>{said}</p>

          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18, pointerEvents: "auto" }}>
            {/* Session 152 — no Enter button.
                A door that has already swung open, with the room lit behind it
                and her standing in it, does not need a second confirmation that
                you would like to go in. Once everything is on screen the scene
                hands over: the camera walks. Until then it says what it is
                waiting for rather than offering a button that is not ready. */}
            {decision === "open_door" && !ready && (
              <p style={{ textAlign: "center", fontSize: 10, letterSpacing: ".14em",
                textTransform: "uppercase", color: "rgba(255,255,255,.3)", margin: 0 }}>
                {loadPct !== null ? `${actorName} · ${loadPct}%` : "…"}
              </p>
            )}
            {(phase === "error" || decision === "ignore" || decision === "pretend_away") && (
              <button className={styles.leaveSceneBtn} onClick={onLeave}>Walk away</button>
            )}
            {decision === "send_text" && (
              <button className={styles.enterBtn}
                onClick={() => (window.location.href = `/messages?actor=${actorId}`)}>Read it</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
