import * as THREE from "three";

// ── The landing outside somebody's front door ────────────────────────────────
//
// Session 152 — built in code, on purpose.
//
// The obvious move was to point the camera at the `entrance_door` node in
// studio_apartment.glb. That works for exactly that file: modern_apartment.glb
// calls the same thing `EnteranceDoor_Wood0035_0` (suffixed by its material,
// and misspelled), the two were exported by different tools — Sketchfab and
// glTF-Transform — and neither carries a single `extras` field to hook on to.
// Home meshes come from asset stores. There is no convention to rely on and no
// reason the next one will match either of these.
//
// So the seam is the door plane, not the door node: outside is ours, inside is
// the mesh's. What an apartment mesh must provide for a knock to work is
// nothing at all, which is the test of whether the boundary is in the right
// place. It also means the flat behind the door can be swapped, re-exported or
// bought from somewhere else without this file knowing.
//
// The trade is real and worth stating: you never see the door that was modelled
// in the flat. From a stairwell that reads true — a Stockholm apartment door is
// a generic object, and what makes it hers is the address, the nameplate, and
// the light coming under it. All three are here.

// Every door is a different door, and the same door every time you come back.
// Same deterministic-hash trick the portraits use: no authoring, no storage,
// and Lindsey's door is Lindsey's door for as long as she lives there.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
}
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length) % xs.length];

// Paints you actually meet in a Stockholm stairwell. Nothing primary, nothing
// that reads as a front door in a cartoon.
const PAINTS = [
  { name: "oxblood",     hex: 0x72382f },
  { name: "deep green",  hex: 0x334a3c },
  { name: "grey blue",   hex: 0x51606c },
  { name: "warm cream",  hex: 0xd8cdb8 },
  { name: "dark walnut", hex: 0x63472f },
  { name: "slate",       hex: 0x4e4e52 },
];
const WALLS = [0xcfc7b8, 0xc4c0b6, 0xd6cfc0, 0xb9b6ae, 0xc9bfae];
const MATS  = [0x4a4038, 0x3b4038, 0x52463a, 0x2f3134];

export function buildLanding(scene, { placeId, surname, panelStyle }) {
  const rand  = seeded(placeId || "unknown");
  const paint = pick(rand, PAINTS);
  const wall  = pick(rand, WALLS);
  const mat   = pick(rand, MATS);
  const brass = rand() > 0.42;
  const panels = panelStyle || pick(rand, ["four", "two", "flat"]);
  const hasMat = rand() > 0.25;

  // Deep enough to stand back from the door and still have wall behind you.
  const W = 3.2, H = 2.72, D = 3.7;          // the landing box
  const DW = 0.9, DH = 2.07;                  // the doorway

  const group = new THREE.Group();

  const plaster = new THREE.MeshStandardMaterial({ color: wall, roughness: .96, metalness: 0 });
  const stone   = new THREE.MeshStandardMaterial({ color: 0x8c857a, roughness: .9 });
  const trim    = new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: .7 });

  const box = (w, h, d, m, x, y, z) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true;
    group.add(o); return o;
  };

  // Floor, ceiling, side walls, and the wall behind you. A landing is a small
  // room, and it has to feel closed or the camera is standing in a void.
  box(W, .04, D, stone,   0, -0.02, D / 2);
  box(W, .04, D, plaster, 0, H,     D / 2);
  box(.06, H, D, plaster, -W / 2, H / 2, D / 2);
  box(.06, H, D, plaster,  W / 2, H / 2, D / 2);
  box(W, H, .06, plaster,  0, H / 2, D);

  // Her wall, built around the opening rather than cut out of it — three boxes
  // beat CSG for something this simple.
  const side = (W - DW) / 2;
  box(side, H, .12, plaster, -(DW / 2 + side / 2), H / 2, 0);
  box(side, H, .12, plaster,  (DW / 2 + side / 2), H / 2, 0);
  box(DW, H - DH, .12, plaster, 0, DH + (H - DH) / 2, 0);

  // Architrave — the difference between a doorway and a hole.
  box(.07, DH + .09, .05, trim, -(DW / 2 + .03), (DH + .09) / 2, .07);
  box(.07, DH + .09, .05, trim,  (DW / 2 + .03), (DH + .09) / 2, .07);
  box(DW + .17, .07, .05, trim, 0, DH + .05, .07);
  box(W, .11, .03, trim, 0, .055, .02);   // skirting

  // ── the door itself, hinged left ──────────────────────────────────────────
  // Session 152 — this door is the understudy.
  //
  // Where a home mesh keeps its front door as a separate object, that door is
  // the one you knock on and the one that swings: the flat is loaded while she
  // is deciding rather than after she has opened, and its leaf is re-parented
  // onto a pivot at the hinge. You get her actual door, and the earlier trade —
  // that you would never see it — is off the table.
  //
  // This one is built for the meshes where that is impossible. modern_apartment
  // has no door object to swing: the exporter fused every wooden surface in the
  // flat into a single 17.65m mesh. It stays hidden until we know which case we
  // are in, with the opening backed by a dark panel so it never reads as a hole.
  const hinge = new THREE.Group();
  hinge.position.set(-DW / 2, 0, 0);
  hinge.visible = false;
  group.add(hinge);

  const blank = new THREE.Mesh(
    new THREE.PlaneGeometry(DW, DH),
    new THREE.MeshStandardMaterial({ color: 0x14110d, roughness: 1 }));
  blank.position.set(0, DH / 2, -0.02);
  group.add(blank);

  const doorMat = new THREE.MeshStandardMaterial({ color: paint.hex, roughness: .58, metalness: .04 });
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(DW - .01, DH, .045), doorMat);
  leaf.position.set((DW - .01) / 2, DH / 2, 0);
  leaf.castShadow = true;
  hinge.add(leaf);

  // Recessed panels. Slightly darker, slightly proud — enough for the light to
  // find an edge, which is all a panel is.
  const panelMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(paint.hex).multiplyScalar(.86), roughness: .62 });
  const panel = (px, py, pw, ph) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, .012), panelMat);
    p.position.set(px, py, .028);
    hinge.add(p);
  };
  const cx = (DW - .01) / 2;
  if (panels === "four") {
    panel(cx, 1.52, DW - .26, .74); panel(cx, .62, DW - .26, .82);
  } else if (panels === "two") {
    panel(cx, 1.34, DW - .24, 1.18);
  }

  // Handle and letterbox
  const metal = new THREE.MeshStandardMaterial({
    color: brass ? 0xb08d4f : 0x9aa0a6, roughness: .3, metalness: .85 });
  const lever = new THREE.Mesh(new THREE.BoxGeometry(.11, .022, .022), metal);
  lever.position.set(DW - .16, 1.04, .05); hinge.add(lever);
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, .02, 20), metal);
  rose.rotation.x = Math.PI / 2; rose.position.set(DW - .1, 1.04, .04); hinge.add(rose);

  // Nameplate — the one thing on this landing that is actually about her.
  if (surname) {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = brass ? "#b08d4f" : "#9aa0a6";
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = "rgba(0,0,0,.72)";
    g.font = "500 30px 'DM Sans', system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.letterSpacing = "6px";
    g.fillText(surname.toUpperCase().slice(0, 12), 128, 34);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(.24, .06),
      new THREE.MeshStandardMaterial({ map: tex, roughness: .3, metalness: .75 }));
    plate.position.set(cx, 1.62, .038);
    hinge.add(plate);

    const screw = new THREE.Mesh(new THREE.CylinderGeometry(.004, .004, .006, 8), metal);
    screw.rotation.x = Math.PI / 2;
    for (const dx of [-.105, .105]) {
      const s2 = screw.clone();
      s2.position.set(cx + dx, 1.62, .04);
      hinge.add(s2);
    }
  }

  if (hasMat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(.72, .022, .44),
      new THREE.MeshStandardMaterial({ color: mat, roughness: 1 }));
    m.position.set(0, .011, .38); m.receiveShadow = true; group.add(m);
  }

  // ── light ─────────────────────────────────────────────────────────────────
  // A stairwell bulb behind and above you, so the door is lit by the hall and
  // not by the sun. Warm, dim, and the only real source out here.
  const bulb = new THREE.PointLight(0xffe2bb, 30, 13, 2);
  bulb.position.set(0, H - .26, D - 1.05);
  bulb.castShadow = true;
  bulb.shadow.mapSize.set(1024, 1024);
  bulb.shadow.bias = -0.0015;
  group.add(bulb);

  const shade = new THREE.Mesh(new THREE.SphereGeometry(.09, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xfff0d4, emissive: 0xffcf90, emissiveIntensity: 1.6, roughness: .5 }));
  shade.position.copy(bulb.position); group.add(shade);

  // Ambient, key and rim are not set here. They belong to the scene, because
  // they are the user's — exposure, sun angle and the rest come off the 3D
  // character tab, and a hall that lit itself would ignore them. This bulb
  // stays: it is a practical, a light that exists in the fiction, and it is the
  // reason there is any light on this side of the door at all.

  // The line of light under her door. It is off until she is up, and it is the
  // only thing on this landing that tells you anything about the person inside.
  const under = new THREE.Mesh(
    new THREE.PlaneGeometry(DW - .06, .045),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0 }));
  under.rotation.x = -Math.PI / 2;
  under.position.set(0, .006, .05);
  group.add(under);

  scene.add(group);

  return { group, hinge, blank, under, bulb, doorWidth: DW, doorHeight: DH, depth: D,
           paint: paint.name, panels, brass };
}
