// Decoded-image cache for image items: keyed by item id, LRU-capped (a 1600px image is ~10 MB decoded).

const MAX_DECODED = 12;

export function decodeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export class ImageCache {
  /** @param {() => void} onReady called when a pending image finishes decoding */
  constructor(onReady) {
    this.onReady = onReady;
    this.map = new Map(); // id → {src, img, ready, used}
    this.tick = 0;
  }

  /** Returns a drawable image or null (decode in flight / failed). */
  get(item) {
    let e = this.map.get(item.id);
    if (!e || e.src !== item.src) {
      e = { src: item.src, img: null, ready: false, failed: false, used: this.tick };
      this.map.set(item.id, e);
      decodeImage(item.src).then((img) => {
        if (this.map.get(item.id) !== e) return; // evicted or replaced meanwhile
        e.img = img; e.ready = !!img; e.failed = !img;
        if (img) this.onReady();
      });
    }
    e.used = this.tick;
    return e.ready ? e.img : null;
  }

  /** Call once per frame after drawing: evicts least-recently-used images not drawn this frame. */
  endFrame() {
    if (this.map.size > MAX_DECODED) {
      const old = [...this.map.entries()].filter(([, e]) => e.used < this.tick).sort((a, b) => a[1].used - b[1].used);
      while (this.map.size > MAX_DECODED && old.length) {
        const [id, e] = old.shift();
        if (e.img) e.img.src = '';
        this.map.delete(id);
      }
    }
    this.tick++;
  }

  clear() {
    for (const e of this.map.values()) if (e.img) e.img.src = '';
    this.map.clear();
  }
}
