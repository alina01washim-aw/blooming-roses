/* ===========================================================
   Roses — Real-time Hand Gesture Flower Controller
   ===========================================================
   Uses MediaPipe Hands to track hand gestures and render a
   procedural glowing flower that blooms, grows, and sways
   with wind — all on a Canvas overlay atop the webcam feed.
   =========================================================== */

// =============================================================
// NOISE — Organic movement via layered sine waves
// =============================================================
class OrganicNoise {
    constructor() {
        this.seeds = Array.from({ length: 8 }, () => Math.random() * 1000);
    }

    /** Returns a value roughly in [-1, 1] */
    get(t, channel = 0) {
        const s = this.seeds[channel % this.seeds.length];
        return (
            Math.sin(t * 0.7 + s) * 0.4 +
            Math.sin(t * 1.3 + s * 1.7) * 0.3 +
            Math.sin(t * 2.1 + s * 0.3) * 0.2 +
            Math.sin(t * 3.7 + s * 2.1) * 0.1
        );
    }
}

// =============================================================
// PARTICLE — Floating pollen / sparkle
// =============================================================
class Particle {
    constructor(cw, ch) {
        this.cw = cw;
        this.ch = ch;
        this.reset(true);
    }

    reset(initial = false) {
        this.x = Math.random() * this.cw;
        this.y = initial ? Math.random() * this.ch : this.ch + Math.random() * 40;
        this.radius = Math.random() * 2.5 + 0.5;
        this.vx = (Math.random() - 0.5) * 0.3;
        this.vy = -(Math.random() * 0.6 + 0.15);
        this.life = Math.random() * 300 + 150;
        this.maxLife = this.life;
        this.hue = 330 + Math.random() * 40;          // pink-ish
        this.brightness = 70 + Math.random() * 20;
        this.flickerPhase = Math.random() * Math.PI * 2;
    }

    update(windForce, dt) {
        this.x += this.vx + windForce * 1.8;
        this.y += this.vy;
        this.life -= dt;
        if (this.life <= 0 || this.y < -20 || this.x < -20 || this.x > this.cw + 20) {
            this.reset();
        }
    }

    draw(ctx) {
        const t = this.life / this.maxLife;
        const flicker = 0.5 + 0.5 * Math.sin(this.life * 0.08 + this.flickerPhase);
        const alpha = t * 0.75 * flicker;
        if (alpha < 0.02) return;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 12;
        ctx.shadowColor = `hsla(${this.hue}, 100%, ${this.brightness}%, 0.8)`;
        ctx.fillStyle = `hsla(${this.hue}, 90%, ${this.brightness}%, 1)`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// =============================================================
// MAIN APPLICATION
// =============================================================
class FlowerBloomApp {
    constructor() {
        // DOM
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.video = document.getElementById('webcam');
        this.loadingEl = document.getElementById('loading');
        this.instructionsEl = document.getElementById('instructions');

        // Noise
        this.noise = new OrganicNoise();

        // Time
        this.time = 0;
        this.lastTimestamp = 0;

        // Gesture state (smoothed values)
        this.bloom = 0;
        this.growth = 0;
        this.windForce = 0;

        // Gesture targets (raw from detection)
        this.targetBloom = 0;
        this.targetGrowth = 0;
        this.targetWindForce = 0;

        // Previous hand X for velocity-based wind
        this.prevHandX = 0.5;

        // Hand landmarks (updated each frame by MediaPipe)
        this.handLandmarks = [];
        this.handHandedness = [];
        this.handsDetected = 0;

        // Particles
        this.particles = [];

        // Setup
        this.resize();
        window.addEventListener('resize', () => this.resize());

        this.initParticles();
        this.initHandTracking();

        // Hide instructions after 8 seconds
        setTimeout(() => {
            this.instructionsEl?.classList.add('hidden');
        }, 8000);

        // Kick off render
        requestAnimationFrame((ts) => this.animate(ts));
    }

    // ---------------------------------------------------------
    // Setup
    // ---------------------------------------------------------
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;

        // Re-bound particles
        for (const p of this.particles) {
            p.cw = this.canvas.width;
            p.ch = this.canvas.height;
        }
    }

    initParticles() {
        const count = 60;
        for (let i = 0; i < count; i++) {
            this.particles.push(new Particle(this.canvas.width, this.canvas.height));
        }
    }

    initHandTracking() {
        const hands = new Hands({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
        });

        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.65,
            minTrackingConfidence: 0.5,
        });

        hands.onResults((r) => this.onHandResults(r));

        const cam = new Camera(this.video, {
            onFrame: async () => {
                await hands.send({ image: this.video });
            },
            width: 1280,
            height: 720,
        });

        cam.start().then(() => {
            setTimeout(() => this.loadingEl?.classList.add('hidden'), 600);
        });
    }

    // ---------------------------------------------------------
    // Hand results callback
    // ---------------------------------------------------------
    onHandResults(results) {
        this.handLandmarks = results.multiHandLandmarks || [];
        this.handHandedness = results.multiHandedness || [];
        this.handsDetected = this.handLandmarks.length;

        let leftPinch = 0;
        let rightPinch = 0;
        let hasLeft = false;
        let hasRight = false;

        if (this.handsDetected > 0) {
            for (let i = 0; i < this.handsDetected; i++) {
                const hand = this.handLandmarks[i];
                const handedness = results.multiHandedness[i];
                // MediaPipe handedness label is 'Left' or 'Right'
                const isLeft = handedness && handedness.label === 'Left';
                const pinch = this.calcPinchDistance(hand);

                if (isLeft) {
                    leftPinch = pinch;
                    hasLeft = true;
                } else {
                    rightPinch = pinch;
                    hasRight = true;
                }

                // Wind from hand horizontal velocity
                const c = this.palmCenter(hand);
                const dx = c.x - this.prevHandX;
                this.targetWindForce = dx * 12;
                this.prevHandX = c.x;
            }

            // Left hand controls Bloom
            this.targetBloom = hasLeft ? leftPinch : 0;

            // Right hand controls Growth
            this.targetGrowth = hasRight ? rightPinch : 0;
        } else {
            // No hands → slowly close and shrink back to 0
            this.targetBloom *= 0.94;
            this.targetGrowth *= 0.94;
            this.targetWindForce *= 0.9;
        }
    }

    /**
     * Pinch distance: distance between thumb tip (4) and index fingertip (8),
     * normalized by hand size so it works at any distance from the camera.
     * Returns 0 (pinched) → 1 (fully spread).
     */
    calcPinchDistance(lm) {
        const thumb = lm[4];   // thumb tip
        const index = lm[8];   // index fingertip
        const wrist = lm[0];
        const mcp = lm[9];     // middle-finger MCP

        // Reference = wrist-to-MCP distance (scales with hand size in frame)
        const ref = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y);
        if (ref < 0.01) return 0;

        const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        // Normalize: pinch ~0 when touching, ~1 when spread wide
        return Math.min(1, Math.max(0, (dist / ref - 0.15) * 1.6));
    }

    /** Rough palm center (average of wrist + MCP joints) */
    palmCenter(lm) {
        const ids = [0, 5, 9, 13, 17];
        let x = 0, y = 0;
        for (const i of ids) { x += lm[i].x; y += lm[i].y; }
        return { x: x / ids.length, y: y / ids.length };
    }

    // =============================================================
    // RENDERING
    // =============================================================

    // ----- Hand Skeleton -----
    drawHandSkeleton(lm, handedness) {
        const ctx = this.ctx;
        const cw = this.canvas.width;
        const ch = this.canvas.height;

        // Draw guide line between thumb tip (4) and index fingertip (8)
        const thumbTip = lm[4];
        const indexTip = lm[8];
        if (thumbTip && indexTip) {
            const tx = thumbTip.x * cw;
            const ty = thumbTip.y * ch;
            const ix = indexTip.x * cw;
            const iy = indexTip.y * ch;

            const isLeft = handedness && handedness.label === 'Left';
            const labelText = isLeft ? '✿ Left Hand: Bloom' : '🌱 Right Hand: Grow';
            const glowColor = isLeft ? 'rgba(255, 80, 130, 0.85)' : 'rgba(56, 193, 114, 0.85)';
            const strokeStyle = isLeft ? '#ff5082' : '#38c172';

            ctx.save();
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = strokeStyle;
            ctx.shadowBlur = 8;
            ctx.shadowColor = glowColor;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(ix, iy);
            ctx.stroke();
            ctx.restore();

            // Draw glowing circles at thumb and index tips
            ctx.save();
            ctx.shadowBlur = 10;
            ctx.shadowColor = glowColor;
            ctx.fillStyle = strokeStyle;
            ctx.beginPath();
            ctx.arc(tx, ty, 6, 0, Math.PI * 2);
            ctx.arc(ix, iy, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            // Draw unmirrored text label at the midpoint
            const midX = (tx + ix) / 2;
            const midY = (ty + iy) / 2;

            ctx.save();
            // Counter-flip coordinates on X around the canvas center to make text unmirrored
            ctx.translate(cw, 0);
            ctx.scale(-1, 1);

            ctx.font = 'bold 12px Inter, sans-serif';
            const textWidth = ctx.measureText(labelText).width;
            const paddingX = 10;
            const paddingY = 6;
            const pillWidth = textWidth + paddingX * 2;
            const pillHeight = 22;

            const drawX = cw - midX;
            const drawY = midY - 20; // draw slightly above the midpoint

            // Draw background pill
            ctx.fillStyle = 'rgba(10, 5, 20, 0.8)';
            ctx.strokeStyle = strokeStyle;
            ctx.lineWidth = 1;
            ctx.shadowBlur = 6;
            ctx.shadowColor = glowColor;
            ctx.beginPath();
            ctx.roundRect(drawX - pillWidth / 2, drawY - pillHeight / 2, pillWidth, pillHeight, 6);
            ctx.fill();
            ctx.stroke();

            // Draw text
            ctx.fillStyle = '#ffffff';
            ctx.shadowBlur = 0;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, drawX, drawY);

            ctx.restore();
        }
    }

    // ----- Stem -----
    drawStem(baseX, baseY, height, windAngle) {
        const ctx = this.ctx;
        const segs = 24;
        const segH = height / segs;

        // Build stem path points
        const pts = [{ x: baseX, y: baseY }];
        for (let i = 1; i <= segs; i++) {
            const t = i / segs;
            const windBend = windAngle * t * t * 40;
            const sway = this.noise.get(this.time * 0.6 + i * 0.25, 0) * 10 * t;
            pts.push({
                x: baseX + windBend + sway,
                y: baseY - segH * i,
            });
        }

        // Draw stem (thick gradient line)
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Outer glow
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(40, 120, 35, 0.25)';
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(80, 180, 60, 0.3)';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        // Core stem
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#3a8a30';
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        // Leaves
        this.drawLeaves(pts);

        ctx.restore();

        return { tip: pts[pts.length - 1], pts };
    }

    drawLeaves(stemPts) {
    const ctx = this.ctx;

    // More leaves distributed along the main stem
    const positions = [0.18, 0.30, 0.42, 0.54, 0.66, 0.78, 0.88];

    for (let li = 0; li < positions.length; li++) {
        const idx = Math.floor(positions[li] * (stemPts.length - 1));
        const pt = stemPts[idx];

        if (!pt) continue;

        // Alternate sides
        const side = li % 2 === 0 ? 1 : -1;

        // Larger, more visible leaves
        const len = 30 + this.growth * 18;

        // Slightly irregular natural angle
        const angle =
            side * (
                0.45 +
                this.noise.get(this.time * 0.6 + li * 2.5, 2) * 0.18
            );

        ctx.save();

        ctx.translate(pt.x, pt.y);
        ctx.rotate(angle);

        // Leaf gradient
        const grad = ctx.createLinearGradient(0, 0, len, 0);

        grad.addColorStop(
            0,
            'rgba(45, 130, 40, 0.95)'
        );

        grad.addColorStop(
            0.55,
            'rgba(65, 165, 55, 0.90)'
        );

        grad.addColorStop(
            1,
            'rgba(80, 185, 65, 0.72)'
        );

        ctx.fillStyle = grad;

        // Soft green glow
        ctx.shadowBlur = 5;
        ctx.shadowColor = 'rgba(70, 190, 70, 0.30)';

        // Leaf shape
        ctx.beginPath();

        ctx.moveTo(0, 0);

        ctx.bezierCurveTo(
            len * 0.22, -len * 0.42,
            len * 0.68, -len * 0.42,
            len, -len * 0.05
        );

        ctx.bezierCurveTo(
            len * 0.70, len * 0.38,
            len * 0.25, len * 0.32,
            0, 0
        );

        ctx.fill();

        // Central vein
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(30, 95, 30, 0.65)';
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        ctx.moveTo(3, 0);
        ctx.lineTo(len * 0.88, -len * 0.03);
        ctx.stroke();

        // Small side veins
        ctx.strokeStyle = 'rgba(35, 105, 35, 0.35)';
        ctx.lineWidth = 0.7;

        for (let v = 0.25; v < 0.85; v += 0.18) {
            ctx.beginPath();
            ctx.moveTo(len * v, -len * 0.02);
            ctx.lineTo(len * (v + 0.08), -len * 0.20);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(len * v, -len * 0.02);
            ctx.lineTo(len * (v + 0.08), len * 0.15);
            ctx.stroke();
        }

        ctx.restore();
    }
}

// ----- Flower Head — Realistic Rose -----

drawFlowerHead(cx, cy, bloom, windAngle, scale) {

    const ctx = this.ctx;

    const b = Math.max(0, Math.min(1, bloom));

    // Stronger bloom response.
    // This makes the difference between bud and full flower more obvious.
    const open = Math.pow(b, 0.72);

    // ---------------------------------------------------------
    // ROSE SHAPE
    // ---------------------------------------------------------
    // Closed = tall and narrow
    // Open   = wider and slightly fuller

    const width =
        scale * (16 + open * 12);

    const height =
        scale * (62 + open * 12);

    // Keep the overall flower size stable.
    const roseScale = scale;

    ctx.save();
    ctx.translate(cx, cy);

    // ---------------------------------------------------------
    // SOFT ROSE GLOW
    // ---------------------------------------------------------

    const glowRadius =
        (30 + open * 16) * roseScale;

    const glowY =
        -(height * (0.50 + open * 0.05));

    const glow = ctx.createRadialGradient(
        0,
        glowY,
        0,
        0,
        glowY,
        glowRadius
    );

    glow.addColorStop(
        0,
        `rgba(255, 90, 145, ${0.12 + open * 0.16})`
    );

    glow.addColorStop(
        0.45,
        `rgba(255, 40, 100, ${0.06 + open * 0.08})`
    );

    glow.addColorStop(
        1,
        'rgba(255, 20, 80, 0)'
    );

    ctx.fillStyle = glow;

    ctx.beginPath();

    ctx.arc(
        0,
        glowY,
        glowRadius,
        0,
        Math.PI * 2
    );

    ctx.fill();

    // ---------------------------------------------------------
    // OUTER ROSE PETALS
    // ---------------------------------------------------------

    const outer = [
        { a: -1.15, w: 0.62, h: 0.86 },
        { a: -0.82, w: 0.82, h: 0.96 },
        { a: -0.48, w: 0.96, h: 1.00 },
        { a: -0.16, w: 1.00, h: 0.98 },
        { a:  0.18, w: 1.00, h: 0.98 },
        { a:  0.50, w: 0.94, h: 0.98 },
        { a:  0.82, w: 0.78, h: 0.92 },
        { a:  1.12, w: 0.60, h: 0.84 }
    ];

    for (let i = 0; i < outer.length; i++) {

        const p = outer[i];

        // Almost closed at bloom 0.
        // Fully spread at bloom 1.
        const spread =
            0.035 + open * 0.965;

        const angle =
            p.a * spread +
            windAngle * (0.015 + open * 0.025);

        const petalLength =
            height *
            p.h *
            (0.78 + open * 0.22);

        const petalWidth =
            width *
            p.w *
            (0.62 + open * 0.38);

        this.drawRosePetal(
            ctx,
            angle,
            petalLength,
            petalWidth,
            350 + (i % 3) * 3,
            0.98,
            0.20 + open * 0.38,
            open,
            'outer'
        );
    }

    // ---------------------------------------------------------
    // SECOND / MIDDLE PETAL LAYER
    // ---------------------------------------------------------

    const middle = [
        { a: -0.76, w: 0.80 },
        { a: -0.50, w: 0.90 },
        { a: -0.24, w: 0.96 },
        { a:  0.02, w: 1.00 },
        { a:  0.28, w: 0.96 },
        { a:  0.54, w: 0.90 },
        { a:  0.78, w: 0.80 }
    ];

    for (let i = 0; i < middle.length; i++) {

        const p = middle[i];

        const spread =
            0.015 + open * 0.68;

        const angle =
            p.a * spread +
            windAngle * 0.018;

        const petalLength =
            height *
            (0.62 + open * 0.18);

        const petalWidth =
            width *
            p.w *
            (0.48 + open * 0.30);

        this.drawRosePetal(
            ctx,
            angle,
            petalLength,
            petalWidth,
            345 + (i % 2) * 4,
            1.0,
            0.32 + open * 0.30,
            open,
            'middle'
        );
    }

    // ---------------------------------------------------------
    // INNER CUP
    // ---------------------------------------------------------

    const inner = [
        { a: -0.48, size: 0.68 },
        { a: -0.24, size: 0.76 },
        { a:  0.00, size: 0.82 },
        { a:  0.24, size: 0.76 },
        { a:  0.48, size: 0.68 }
    ];

    for (let i = 0; i < inner.length; i++) {

        const p = inner[i];

        const spread =
            0.01 + open * 0.30;

        const angle =
            p.a * spread;

        this.drawRosePetal(
            ctx,
            angle,
            height * p.size * (0.55 + open * 0.30),
            width * (0.34 + open * 0.24),
            340 + (i % 2) * 5,
            1.0,
            0.52 + open * 0.20,
            open,
            'inner'
        );
    }

    // ---------------------------------------------------------
    // ROSE CENTER
    // ---------------------------------------------------------

    const centerY =
        -height * (0.58 - open * 0.05);

    ctx.save();

    const centerAlpha =
        0.15 + open * 0.80;

    const centerGrad = ctx.createRadialGradient(
        0,
        centerY,
        1,
        0,
        centerY,
        (8 + open * 5) * roseScale
    );

    centerGrad.addColorStop(
        0,
        `rgba(255, 130, 165, ${centerAlpha})`
    );

    centerGrad.addColorStop(
        0.55,
        `rgba(205, 25, 75, ${centerAlpha * 0.95})`
    );

    centerGrad.addColorStop(
        1,
        `rgba(115, 8, 40, ${centerAlpha * 0.45})`
    );

    ctx.fillStyle = centerGrad;

    ctx.beginPath();

    ctx.ellipse(
        0,
        centerY,
        (7 + open * 5) * roseScale,
        (5 + open * 4) * roseScale,
        0,
        0,
        Math.PI * 2
    );

    ctx.fill();

    // ---------------------------------------------------------
    // CENTRAL ROSE SPIRAL
    // ---------------------------------------------------------

    ctx.beginPath();

    const turns =
        0.45 + open * 0.75;

    const points = 42;

    for (let i = 0; i <= points; i++) {

        const t = i / points;

        const angle =
            -Math.PI / 2 +
            t * Math.PI * 2 * turns;

        const radius =
            (2.5 + open * 6.5) *
            roseScale *
            (1 - t * 0.88);

        const x =
            Math.cos(angle) * radius;

        const y =
            centerY +
            Math.sin(angle) * radius * 0.58;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }

    ctx.strokeStyle =
        `rgba(105, 8, 40, ${0.10 + open * 0.28})`;

    ctx.lineWidth =
        Math.max(0.55, 0.85 * roseScale);

    ctx.lineCap = 'round';

    ctx.stroke();

    // ---------------------------------------------------------
    // SOFT GLOWING CENTER
    // ---------------------------------------------------------

    ctx.beginPath();

    ctx.fillStyle =
        `rgba(255, 165, 190, ${0.05 + open * 0.38})`;

    ctx.shadowBlur =
        (1 + open * 4) * roseScale;

    ctx.shadowColor =
        'rgba(255, 90, 140, 0.45)';

    ctx.arc(
        0,
        centerY,
        (0.7 + open * 0.7) * roseScale,
        0,
        Math.PI * 2
    );

    ctx.fill();

    ctx.restore();

    // ---------------------------------------------------------
    // FOLDED ROSE EDGES
    // ---------------------------------------------------------

    ctx.save();

    ctx.strokeStyle =
        `rgba(120, 10, 45, ${0.20 + open * 0.20})`;

    ctx.lineWidth =
        Math.max(0.7, 1.0 * roseScale);

    // LEFT

    ctx.beginPath();

    ctx.moveTo(
        -width * (0.28 + open * 0.25),
        -height * 0.22
    );

    ctx.bezierCurveTo(
        -width * (0.40 + open * 0.40),
        -height * 0.38,
        -width * (0.34 + open * 0.32),
        -height * 0.60,
        -width * (0.16 + open * 0.18),
        -height * 0.68
    );

    ctx.stroke();

    // RIGHT

    ctx.beginPath();

    ctx.moveTo(
        width * (0.28 + open * 0.25),
        -height * 0.22
    );

    ctx.bezierCurveTo(
        width * (0.40 + open * 0.40),
        -height * 0.38,
        width * (0.34 + open * 0.32),
        -height * 0.60,
        width * (0.16 + open * 0.18),
        -height * 0.68
    );

    ctx.stroke();

    ctx.restore();

    ctx.restore();
} 

// ----- Rose Petal -----

drawRosePetal(ctx, angle, length, width, hue, alpha, curl, bloom, layer) {

    const ctx2 = ctx;

    ctx2.save();
    ctx2.rotate(angle);

    // ---------------------------------------------------------
    // BLOOM CONTROL
    // ---------------------------------------------------------

    const b = Math.max(0, Math.min(1, bloom));
    const open = Math.pow(b, 0.78);

    // ---------------------------------------------------------
    // PETAL CHARACTER
    // ---------------------------------------------------------

    let side = 1.0;
    let shoulder = 0.68;
    let tipHeight = 0.84;
    let curlAmount = 0.20;

    if (layer === 'outer') {

        side = 1.08;
        shoulder = 0.62;
        tipHeight = 0.78;
        curlAmount = 0.30 + open * 0.32;

    } else if (layer === 'middle') {

        side = 0.92;
        shoulder = 0.68;
        tipHeight = 0.84;
        curlAmount = 0.24 + open * 0.24;

    } else {

        side = 0.72;
        shoulder = 0.74;
        tipHeight = 0.90;
        curlAmount = 0.16 + open * 0.16;
    }

    const w = width * side;
    const h = length;

    // ---------------------------------------------------------
    // NATURAL PETAL VARIATION
    // ---------------------------------------------------------

    const variation =
        Math.sin(angle * 4.7 + length * 0.013);

    const leftBias =
        1.0 + variation * 0.055;

    const rightBias =
        1.0 - variation * 0.045;

    const topBias =
        1.0 + variation * 0.035;

    // ---------------------------------------------------------
    // PETAL GRADIENT
    // ---------------------------------------------------------

    const grad = ctx2.createLinearGradient(
        0,
        0,
        0,
        -h
    );

    grad.addColorStop(
        0,
        `hsla(${hue + 3}, 82%, 28%, ${alpha})`
    );

    grad.addColorStop(
        0.20,
        `hsla(${hue}, 88%, 39%, ${alpha})`
    );

    grad.addColorStop(
        0.50,
        `hsla(${hue - 1}, 90%, 49%, ${alpha * 0.98})`
    );

    grad.addColorStop(
        0.78,
        `hsla(${hue + 3}, 92%, 58%, ${Math.min(1, alpha + 0.015)})`
    );

    grad.addColorStop(
        1,
        `hsla(${hue + 8}, 94%, 68%, ${Math.min(1, alpha + 0.025)})`
    );

    ctx2.fillStyle = grad;

    // ---------------------------------------------------------
    // VERY SOFT PETAL GLOW
    // ---------------------------------------------------------

    ctx2.shadowBlur =
        2.5 + open * 4;

    ctx2.shadowColor =
        `hsla(${hue}, 95%, 55%, ${0.06 + open * 0.10})`;

    // ---------------------------------------------------------
    // MAIN PETAL
    // ---------------------------------------------------------

    ctx2.beginPath();

    ctx2.moveTo(0, 0);

    // LEFT LOWER CUP

    ctx2.bezierCurveTo(
        -w * 0.30 * leftBias,
        -h * 0.07,

        -w * 0.78 * leftBias,
        -h * 0.20,

        -w * 0.94 * leftBias,
        -h * shoulder
    );

    // LEFT OUTER CURL

    ctx2.bezierCurveTo(
        -w * (0.98 + curlAmount * 0.12) * leftBias,
        -h * (0.78 + curlAmount * 0.05),

        -w * (0.68 + curlAmount * 0.16),
        -h * (0.95 + curlAmount * 0.025),

        -w * 0.18,
        -h * tipHeight * topBias
    );

    // TOP CURL

    ctx2.bezierCurveTo(
        -w * 0.07,
        -h * (tipHeight + 0.045),

        w * 0.08,
        -h * (tipHeight + 0.025),

        w * 0.20,
        -h * tipHeight
    );

    // RIGHT OUTER CURL

    ctx2.bezierCurveTo(
        w * (0.65 + curlAmount * 0.14),
        -h * (0.95 + curlAmount * 0.025),

        w * (0.99 + curlAmount * 0.10) * rightBias,
        -h * (0.78 + curlAmount * 0.04),

        w * 0.92 * rightBias,
        -h * shoulder
    );

    // RIGHT LOWER CUP

    ctx2.bezierCurveTo(
        w * 0.78 * rightBias,
        -h * 0.20,

        w * 0.30 * rightBias,
        -h * 0.07,

        0,
        0
    );

    ctx2.closePath();
    ctx2.fill();

    // ---------------------------------------------------------
    // RESET SHADOW
    // ---------------------------------------------------------

    ctx2.shadowBlur = 0;

    // ---------------------------------------------------------
    // SOFT INNER FOLD
    // ---------------------------------------------------------

    ctx2.beginPath();

    ctx2.moveTo(
        -w * 0.05,
        -h * 0.10
    );

    ctx2.bezierCurveTo(
        -w * (0.30 + open * 0.06),
        -h * 0.25,

        -w * (0.46 + open * 0.08),
        -h * (0.50 + curlAmount * 0.10),

        -w * (0.21 + open * 0.05),
        -h * (0.77 + curlAmount * 0.03)
    );

    ctx2.bezierCurveTo(
        -w * 0.12,
        -h * 0.82,

        -w * 0.06,
        -h * 0.80,

        0,
        -h * 0.74
    );

    ctx2.strokeStyle =
        `hsla(${hue - 12}, 72%, 23%, ${0.09 + open * 0.10})`;

    ctx2.lineWidth =
        Math.max(0.55, width * 0.014);

    ctx2.lineCap = 'round';
    ctx2.stroke();

    // ---------------------------------------------------------
    // VERY SOFT RIGHT FOLD
    // ---------------------------------------------------------

    ctx2.beginPath();

    ctx2.moveTo(
        w * 0.05,
        -h * 0.10
    );

    ctx2.bezierCurveTo(
        w * (0.30 + open * 0.06),
        -h * 0.25,

        w * (0.45 + open * 0.08),
        -h * (0.49 + curlAmount * 0.10),

        w * (0.19 + open * 0.05),
        -h * (0.75 + curlAmount * 0.03)
    );

    ctx2.bezierCurveTo(
        w * 0.11,
        -h * 0.81,

        w * 0.05,
        -h * 0.79,

        0,
        -h * 0.73
    );

    ctx2.strokeStyle =
        `hsla(${hue - 10}, 72%, 26%, ${0.07 + open * 0.08})`;

    ctx2.lineWidth =
        Math.max(0.5, width * 0.012);

    ctx2.lineCap = 'round';
    ctx2.stroke();

    // ---------------------------------------------------------
    // SOFT OUTER EDGE
    // ---------------------------------------------------------

    if (open > 0.20) {

        const edgeAlpha =
            (open - 0.20) * 0.16;

        ctx2.beginPath();

        ctx2.moveTo(
            -w * 0.62,
            -h * (shoulder + 0.03)
        );

        ctx2.bezierCurveTo(
            -w * 0.76,
            -h * 0.72,

            -w * 0.57,
            -h * 0.87,

            -w * 0.25,
            -h * 0.91
        );

        ctx2.strokeStyle =
            `hsla(${hue + 10}, 92%, 78%, ${edgeAlpha})`;

        ctx2.lineWidth =
            Math.max(0.5, width * 0.010);

        ctx2.stroke();

        ctx2.beginPath();

        ctx2.moveTo(
            w * 0.62,
            -h * (shoulder + 0.03)
        );

        ctx2.bezierCurveTo(
            w * 0.76,
            -h * 0.72,

            w * 0.57,
            -h * 0.87,

            w * 0.25,
            -h * 0.91
        );

        ctx2.strokeStyle =
            `hsla(${hue + 8}, 92%, 76%, ${edgeAlpha * 0.85})`;

        ctx2.stroke();
    }

    // ---------------------------------------------------------
    // VERY SUBTLE CENTRAL HIGHLIGHT
    // ---------------------------------------------------------

    if (open > 0.18) {

        ctx2.beginPath();

        ctx2.moveTo(
            -w * 0.12,
            -h * 0.18
        );

        ctx2.bezierCurveTo(
            -w * 0.21,
            -h * 0.40,

            -w * 0.17,
            -h * 0.61,

            -w * 0.06,
            -h * 0.76
        );

        ctx2.strokeStyle =
            `hsla(${hue + 18}, 95%, 86%, ${0.035 + open * 0.055})`;

        ctx2.lineWidth =
            Math.max(0.5, width * 0.009);

        ctx2.lineCap = 'round';
        ctx2.stroke();
    }

    ctx2.restore();
} 

// =============================================================
// ROSE STEM — Individual curved stem for each flower
// =============================================================
drawRoseStem(baseX, baseY, angle, length, windAngle, scale) {
    const ctx = this.ctx;

    const segs = 18;
    const pts = [{ x: baseX, y: baseY }];

    for (let i = 1; i <= segs; i++) {
        const t = i / segs;

        // Natural upward curve
        const curve = Math.sin(t * Math.PI) * 18 * Math.abs(angle);

        // Wind affects the upper part more than the base
        const wind = windAngle * t * t * 18;

        // Small organic movement
        const sway =
            this.noise.get(
                this.time * 0.55 + i * 0.28 + angle * 3,
                3
            ) * 4 * t;

        const x =
            baseX +
            Math.sin(angle) * length * t +
            curve * Math.sign(angle) +
            wind +
            sway;

        const y =
            baseY -
            Math.cos(angle) * length * t;

        pts.push({ x, y });
    }

    // ---------------------------------------------------------
    // STEM
    // ---------------------------------------------------------
    ctx.save();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Soft outer glow
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
    }

    ctx.lineWidth = 5 * scale;
    ctx.strokeStyle = 'rgba(35, 120, 35, 0.22)';
    ctx.shadowBlur = 7;
    ctx.shadowColor = 'rgba(60, 170, 50, 0.25)';
    ctx.stroke();

    // Main green stem
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
    }

    ctx.lineWidth = 2.8 * scale;
    ctx.strokeStyle = '#32852d';
    ctx.shadowBlur = 0;
    ctx.stroke();

    ctx.restore();

    // Draw leaves attached to THIS individual stem
    this.drawRoseStemLeaves(pts, scale);

    return {
    tip: pts[pts.length - 1],
    pts
}; 
}

// =============================================================
// LEAVES — Natural leaves attached to each rose stem
// =============================================================
drawRoseStemLeaves(stemPts, scale) {

    const ctx = this.ctx;

    if (!stemPts || stemPts.length < 8) return;

    // ---------------------------------------------------------
    // Leaf positions along the stem
    //
    // Avoid the very bottom and very top.
    // Each stem gets 4 leaves.
    // ---------------------------------------------------------
    const positions = [0.18, 0.34, 0.50, 0.66, 0.80, 0.89];

    for (let i = 0; i < positions.length; i++) {

        const t = positions[i];

        const idx =
            Math.floor(
                t * (stemPts.length - 1)
            );

        const pt = stemPts[idx];

        if (!pt) continue;

        // -----------------------------------------------------
        // Determine direction of the stem at this point
        // -----------------------------------------------------

        const prev =
            stemPts[Math.max(0, idx - 1)];

        const next =
            stemPts[Math.min(stemPts.length - 1, idx + 1)];

        const stemAngle =
            Math.atan2(
                next.y - prev.y,
                next.x - prev.x
            );

        // -----------------------------------------------------
        // Alternate sides
        // -----------------------------------------------------

        const side =
            i % 2 === 0 ? -1 : 1;

        // -----------------------------------------------------
        // Leaf size
        // -----------------------------------------------------

        const len =
            (27 + this.growth * 12) *
            scale;

        const width =
            len * 0.46;

        // -----------------------------------------------------
        // Leaf angle
        //
        // The leaf points diagonally outward from the stem.
        // -----------------------------------------------------

        const leafAngle =
            stemAngle +
            side *
            (0.65 + i * 0.035);

        // -----------------------------------------------------
        // Small organic variation
        // -----------------------------------------------------

        const organic =
            this.noise.get(
                this.time * 0.35 + i * 2.7 + t * 10,
                4
            );

        const finalAngle =
            leafAngle +
            organic * 0.08;

        // -----------------------------------------------------
        // DRAW LEAF
        // -----------------------------------------------------

        ctx.save();

        ctx.translate(pt.x, pt.y);
        ctx.rotate(finalAngle);

        // -----------------------------------------------------
        // Leaf gradient
        // -----------------------------------------------------

        const grad =
            ctx.createLinearGradient(
                0,
                0,
                len,
                0
            );

        grad.addColorStop(
            0,
            'rgba(35, 105, 30, 0.98)'
        );

        grad.addColorStop(
            0.45,
            'rgba(50, 145, 38, 0.98)'
        );

        grad.addColorStop(
            0.80,
            'rgba(65, 165, 45, 0.95)'
        );

        grad.addColorStop(
            1,
            'rgba(75, 180, 55, 0.88)'
        );

        ctx.fillStyle = grad;

        // -----------------------------------------------------
        // Soft glow
        // -----------------------------------------------------

        ctx.shadowBlur = 4;
        ctx.shadowColor =
            'rgba(50, 160, 45, 0.28)';

        // -----------------------------------------------------
        // Leaf shape
        //
        // Pointed rose-leaf silhouette.
        // -----------------------------------------------------

        ctx.beginPath();

        ctx.moveTo(0, 0);

        // Upper edge
        ctx.bezierCurveTo(
            len * 0.20,
            -width * 0.75,

            len * 0.58,
            -width,

            len,
            -width * 0.08
        );

        // Lower edge
        ctx.bezierCurveTo(
            len * 0.72,
            width * 0.62,

            len * 0.30,
            width * 0.58,

            0,
            0
        );

        ctx.closePath();

        ctx.fill();

        // -----------------------------------------------------
        // Leaf outline
        // -----------------------------------------------------

        ctx.shadowBlur = 0;

        ctx.strokeStyle =
            'rgba(25, 85, 25, 0.75)';

        ctx.lineWidth =
            Math.max(0.8, 1.0 * scale);

        ctx.stroke();

        // -----------------------------------------------------
        // CENTRAL VEIN
        // -----------------------------------------------------

        ctx.beginPath();

        ctx.moveTo(
            2,
            0
        );

        ctx.quadraticCurveTo(
            len * 0.45,
            -width * 0.05,

            len * 0.91,
            -width * 0.06
        );

        ctx.strokeStyle =
            'rgba(25, 80, 25, 0.72)';

        ctx.lineWidth =
            Math.max(0.8, 1.1 * scale);

        ctx.stroke();

        // -----------------------------------------------------
        // SMALL SIDE VEINS
        // -----------------------------------------------------

        ctx.strokeStyle =
            'rgba(25, 90, 25, 0.42)';

        ctx.lineWidth =
            Math.max(0.5, 0.7 * scale);

        const veins = [0.30, 0.46, 0.62, 0.76];

        for (const v of veins) {

            const x =
                len * v;

            const curve =
                Math.sin(v * Math.PI) *
                width;

            // Upper vein
            ctx.beginPath();

            ctx.moveTo(
                x,
                -curve * 0.02
            );

            ctx.lineTo(
                x + len * 0.10,
                -width * 0.42
            );

            ctx.stroke();

            // Lower vein
            ctx.beginPath();

            ctx.moveTo(
                x,
                -curve * 0.02
            );

            ctx.lineTo(
                x + len * 0.08,
                width * 0.32
            );

            ctx.stroke();
        }

        ctx.restore();
    }
}

    // ----- Side Branches -----
    drawBranch(startX, startY, baseAngle, length, windAngle, scale) {
        const ctx = this.ctx;
        const segs = 12;
        const segL = length / segs;
        const pts = [{ x: startX, y: startY }];

        for (let i = 1; i <= segs; i++) {
            const t = i / segs;
            const windBend = windAngle * t * t * 15;
            const sway = this.noise.get(this.time * 0.8 + i * 0.3, 5) * 4 * t;
            const angle = baseAngle + windBend * 0.02 + sway * 0.01;

            pts.push({
                x: pts[pts.length - 1].x + Math.cos(angle) * segL + windBend * 0.3,
                y: pts[pts.length - 1].y + Math.sin(angle) * segL
            });
        }

        // Draw the branch stem
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Outer glow
        ctx.lineWidth = 4 * scale;
        ctx.strokeStyle = 'rgba(40, 120, 35, 0.2)';
        ctx.shadowBlur = 6;
        ctx.shadowColor = 'rgba(80, 180, 60, 0.25)';
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        // Core branch
        ctx.lineWidth = 2.5 * scale;
        ctx.strokeStyle = '#3a8a30';
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        ctx.restore();

        // Draw a leaf on the branch
        this.drawBranchLeaves(pts, scale);

        return pts[pts.length - 1]; // return branch tip
    }

    drawBranchLeaves(branchPts, scale) {
        const ctx = this.ctx;
        if (branchPts.length < 5) return;
        
        // Leaf in the middle of the branch
        const midIdx = Math.floor(branchPts.length * 0.5);
        const pt = branchPts[midIdx];
        const prevPt = branchPts[midIdx - 1];
        if (!pt || !prevPt) return;
        
        const angle = Math.atan2(pt.y - prevPt.y, pt.x - prevPt.x) + Math.PI / 2;
        const len = 12 * scale * (1 + this.growth);

        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(angle);

        const grad = ctx.createLinearGradient(0, 0, len, 0);
        grad.addColorStop(0, 'rgba(55, 140, 45, 0.8)');
        grad.addColorStop(1, 'rgba(75, 170, 60, 0.4)');
        ctx.fillStyle = grad;

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(len * 0.5, -5, len, -1);
        ctx.quadraticCurveTo(len * 0.5, 5, 0, 0);
        ctx.fill();

        ctx.restore();
    }

    // ----- HUD Overlay -----
    drawHUD() {
        const ctx = this.ctx;
        const cw = this.canvas.width;

        ctx.save();

        // Counter-flip to undo the CSS scaleX(-1) so text is readable
        ctx.translate(cw, 0);
        ctx.scale(-1, 1);

        ctx.font = '600 15px Inter, sans-serif';
        ctx.textAlign = 'left';

        // Position in screen-space top-right (which is canvas top-left after flip)
        const px = 20;
        const py = 22;

        // Background pill
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.beginPath();
        ctx.roundRect(px - 10, py - 14, 138, 78, 10);
        ctx.fill();

        // Bloom
        ctx.fillStyle = 'rgba(255, 170, 200, 0.95)';
        ctx.shadowBlur = 6;
        ctx.shadowColor = 'rgba(255, 100, 150, 0.4)';
        ctx.fillText(`Bloom: ${this.bloom.toFixed(2)}`, px, py + 6);

        // Growth
        ctx.fillStyle = 'rgba(140, 255, 140, 0.95)';
        ctx.shadowColor = 'rgba(80, 255, 80, 0.4)';
        ctx.fillText(`Grow: ${this.growth.toFixed(2)}`, px, py + 28);

        // Wind
        ctx.fillStyle = 'rgba(140, 200, 255, 0.95)';
        ctx.shadowColor = 'rgba(80, 150, 255, 0.4)';
        ctx.fillText(`Wind: ${this.windForce.toFixed(2)}`, px, py + 50);

        ctx.restore();
    }

    // ----- Post-process Glow -----
    drawPostGlow(cx, cy) {
        if (this.bloom < 0.05) return;
        const ctx = this.ctx;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const r = 120 + this.bloom * 160;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(255, 110, 150, ${this.bloom * 0.18})`);
        g.addColorStop(0.5, `rgba(255, 70, 110, ${this.bloom * 0.08})`);
        g.addColorStop(1, 'rgba(255, 50, 80, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // =============================================================
    // ANIMATION LOOP
    // =============================================================
    animate(timestamp) {
        const dt = this.lastTimestamp ? (timestamp - this.lastTimestamp) / 16.67 : 1; // normalised to ~60fps
        this.lastTimestamp = timestamp;
        this.time += 0.016 * dt;

        const ctx = this.ctx;
        const cw = this.canvas.width;
        const ch = this.canvas.height;

        // ---- Smooth interpolation ----
        const lerpSpeed = 0.07 * dt;
        this.bloom += (this.targetBloom - this.bloom) * lerpSpeed;
        this.growth += (this.targetGrowth - this.growth) * 0.05 * dt;
        this.windForce += (this.targetWindForce - this.windForce) * 0.06 * dt;

        // Natural wind always present
        const naturalWind = this.noise.get(this.time * 0.7, 1) * 0.12;
        const totalWind = naturalWind + this.windForce * 0.18;

        // ---- Clear ----
        ctx.clearRect(0, 0, cw, ch);

        // ---- Draw hand skeletons ----
        for (let i = 0; i < this.handLandmarks.length; i++) {
            const lm = this.handLandmarks[i];
            const handedness = this.handHandedness[i];
            this.drawHandSkeleton(lm, handedness);
        }

        // ---- Particles ----
        for (const p of this.particles) {
            p.update(totalWind, dt);
            p.draw(ctx);
        }

       // =============================================================
// ROSE BOUQUET STRUCTURE
// =============================================================
if (this.growth > 0.005) {

    // ---------------------------------------------------------
    // SINGLE COMMON ROOT
    // ---------------------------------------------------------
    const baseX = cw * 0.72;
    const baseY = ch * 0.98;

    const growth = this.growth;

    // Overall flower size
    const flowerScale = 0.99 + 0.4 * growth;

    // ---------------------------------------------------------
    // 9 ROSE STEMS
    //
    // angle:
    //   negative = left
    //   0       = straight up
    //   positive = right
    //
    // The arrangement deliberately follows the reference:
    //
    //              🌹
    //       🌹            🌹
    //
    //   🌹       🌹        🌹
    //
    //        🌹      🌹
    //
    //                 ↓
    //               BASE
    // ---------------------------------------------------------

    const roseConfigs = [

        // =====================================================
        // TOP ROW — 3 roses
        // =====================================================

        // TOP LEFT
        {
            angle: -0.28,
            length: 430,
            scale: 0.92
        },

        // TOP CENTER
        {
            angle: 0.00,
            length: 500,
            scale: 1.00
        },

        // TOP RIGHT
        {
            angle: 0.28,
            length: 430,
            scale: 0.92
        },


        // =====================================================
        // MIDDLE ROW — 3 roses
        // =====================================================

        // LEFT MIDDLE
        {
            angle: -0.52,
            length: 350,
            scale: 0.88
        },

        // CENTER MIDDLE
        {
            angle: -0.03,
            length: 350,
            scale: 0.88
        },

        // RIGHT MIDDLE
        {
            angle: 0.52,
            length: 350,
            scale: 0.88
        },


        // =====================================================
        // LOWER ROW — 3 roses
        // =====================================================

        // LOWER LEFT
        {
            angle: -0.68,
            length: 265,
            scale: 0.82
        },

        // LOWER CENTER
        {
            angle: 0.02,
            length: 245,
            scale: 0.80
        },

        // LOWER RIGHT
        {
            angle: 0.68,
            length: 265,
            scale: 0.82
        }
    ];


    // ---------------------------------------------------------
    // DRAW EACH STEM + FLOWER
    // ---------------------------------------------------------

    for (let i = 0; i < roseConfigs.length; i++) {

        const config = roseConfigs[i];

        const stemLength =
            config.length *
            growth;

        const stemScale =
            0.85 +
            growth * 0.15;

        const stemData =
            this.drawRoseStem(
                baseX,
                baseY,
                config.angle,
                stemLength,
                totalWind,
                stemScale
            );

        const tip = stemData.tip;

        // -----------------------------------------------------
        // FLOWER
        // -----------------------------------------------------

        const flowerSize =
            flowerScale *
            config.scale;

        this.drawFlowerHead(
            tip.x,
            tip.y,
            this.bloom,
            totalWind,
            flowerSize
        );

        this.drawPostGlow(
            tip.x,
            tip.y
        );
    }
}
        // ---- HUD ----
        this.drawHUD();

        requestAnimationFrame((ts) => this.animate(ts));
    }
}

// =============================================================
// BOOT
// =============================================================
window.addEventListener('DOMContentLoaded', () => {
    new FlowerBloomApp();
});
