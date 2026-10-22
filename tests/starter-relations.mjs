#!/usr/bin/env node
/**
 * Scene-specific relation checks for assets/starter.html.
 *
 * Generic delivery/interaction checks live in scripts/audit_scene.mjs. This file
 * demonstrates the required per-scene layer: it reads the rendered DOM path
 * geometry instead of trusting the generator's formulas.
 *
 * Expected failures: root gaps > 1px, any lantern point escaping the bell fill,
 * anchor/cord mismatch > 1px, or non-rigid lantern dimensions.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return require(name);
    } catch {
      // Try a globally installed package below.
    }
  }
  let globalRoot = "";
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    // Fall through with an actionable message.
  }
  for (const name of ["playwright", "playwright-core"]) {
    if (!globalRoot) break;
    try {
      return require(path.join(globalRoot, name));
    } catch {
      // Continue.
    }
  }
  throw new Error("未找到 Playwright。请先安装开发期验收依赖，交付 HTML 本身不依赖它。");
}

async function main() {
  const file = path.resolve(process.argv[2] || ".agents/skills/svg-motion-scene/assets/starter.html");
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    const url = pathToFileURL(file);
    url.searchParams.set("audit", "1");
    await page.goto(url.href, { waitUntil: "load" });
    await page.waitForFunction(() =>
      window.__svgSceneAudit &&
      typeof window.__svgSceneAudit.renderAt === "function" &&
      document.querySelector("[data-scene]"), { timeout: 8000 });
    await page.evaluate(() => {
      const button = document.querySelector("[data-motion-toggle]");
      if (button && button.getAttribute("data-playing") === "true") button.click();
    });
    await page.waitForTimeout(80);

    const metrics = await page.evaluate(() => {
      const audit = window.__svgSceneAudit;
      const bellFill = document.querySelector('[data-part="bell-fill"]');
      const bellRim = document.querySelector('[data-part="bell-rim"]');
      const lantern = document.querySelector('[data-part="lantern"]');
      const anchor = document.querySelector('[data-part="lantern-anchor"]');
      if (!bellFill || !bellRim || !lantern || !anchor) {
        return { ok: false, reason: "starter relation markers are missing" };
      }
      const tentacles = [...document.querySelectorAll('[data-part^="tentacle-"]')]
        .filter((node) => node.tagName.toLowerCase() === "path" && /^tentacle-\d+$/.test(node.getAttribute("data-part") || ""));
      const circles = lantern.querySelectorAll("circle");
      const orb = circles[circles.length - 2];
      const cord = lantern.querySelector("line");
      if (tentacles.length !== 8 || !orb || !cord) {
        return { ok: false, reason: "starter relation geometry is incomplete" };
      }

      function screenPoint(element, point) {
        const matrix = element.getScreenCTM();
        if (!matrix) return { x: NaN, y: NaN };
        return new DOMPoint(point.x, point.y).matrixTransform(matrix);
      }
      function samplePath(element, count) {
        const length = element.getTotalLength();
        const points = [];
        for (let i = 0; i <= count; i += 1) {
          points.push(screenPoint(element, element.getPointAtLength(length * i / count)));
        }
        return points;
      }
      function nearest(point, points) {
        let distance = Infinity;
        for (const candidate of points) {
          distance = Math.min(distance, Math.hypot(point.x - candidate.x, point.y - candidate.y));
        }
        return distance;
      }

      const PHASE_COUNT = 32;
      const RIM_SAMPLES = 720;
      const period = audit.periodMs;
      let maxRootGap = 0;
      let outsideOrbPoints = 0;
      let maxAnchorGap = 0;
      let orbRadiusMin = Infinity;
      let orbRadiusMax = -Infinity;
      let cordLengthMin = Infinity;
      let cordLengthMax = -Infinity;
      let finite = true;

      for (let i = 0; i < PHASE_COUNT; i += 1) {
        audit.renderAt(period * i / PHASE_COUNT);
        const rimPoints = samplePath(bellRim, RIM_SAMPLES);
        for (const tentacle of tentacles) {
          const root = screenPoint(tentacle, tentacle.getPointAtLength(0));
          maxRootGap = Math.max(maxRootGap, nearest(root, rimPoints));
        }

        const cx = Number(orb.getAttribute("cx"));
        const cy = Number(orb.getAttribute("cy"));
        const radius = Number(orb.getAttribute("r"));
        orbRadiusMin = Math.min(orbRadiusMin, radius);
        orbRadiusMax = Math.max(orbRadiusMax, radius);
        const orbCenter = screenPoint(orb, { x: cx, y: cy });
        const inverseBell = bellFill.getScreenCTM().inverse();
        for (let k = 0; k < 16; k += 1) {
          const angle = Math.PI * 2 * k / 16;
          const edge = new DOMPoint(
            orbCenter.x + Math.cos(angle) * radius,
            orbCenter.y + Math.sin(angle) * radius
          );
          if (!bellFill.isPointInFill(edge.matrixTransform(inverseBell))) outsideOrbPoints += 1;
        }

        const anchorPoint = screenPoint(anchor, {
          x: Number(anchor.getAttribute("cx")),
          y: Number(anchor.getAttribute("cy"))
        });
        const cordTop = screenPoint(cord, {
          x: Number(cord.getAttribute("x1")),
          y: Number(cord.getAttribute("y1"))
        });
        const cordBottom = screenPoint(cord, {
          x: Number(cord.getAttribute("x2")),
          y: Number(cord.getAttribute("y2"))
        });
        const cordLength = Math.hypot(cordBottom.x - cordTop.x, cordBottom.y - cordTop.y);
        cordLengthMin = Math.min(cordLengthMin, cordLength);
        cordLengthMax = Math.max(cordLengthMax, cordLength);
        let apex = bellFill.getPointAtLength(0);
        let apexY = apex.y;
        const bellLength = bellFill.getTotalLength();
        for (let k = 0; k <= 720; k += 1) {
          const candidate = bellFill.getPointAtLength(bellLength * k / 720);
          if (candidate.y < apexY) {
            apexY = candidate.y;
            apex = candidate;
          }
        }
        const apexScreen = screenPoint(bellFill, apex);
        maxAnchorGap = Math.max(
          maxAnchorGap,
          Math.hypot(anchorPoint.x - apexScreen.x, anchorPoint.y - apexScreen.y),
          Math.hypot(anchorPoint.x - cordTop.x, anchorPoint.y - cordTop.y)
        );
        for (const point of [anchorPoint, cordTop, cordBottom, apexScreen, orbCenter]) {
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) finite = false;
        }
      }

      const orbRadiusDelta = orbRadiusMax - orbRadiusMin;
      const cordLengthDelta = cordLengthMax - cordLengthMin;
      const ok = finite &&
        maxRootGap <= 1 &&
        outsideOrbPoints === 0 &&
        maxAnchorGap <= 1 &&
        orbRadiusDelta <= 1e-6 &&
        cordLengthDelta <= 1e-3;
      return {
        ok,
        finite,
        phases: PHASE_COUNT,
        maxRootGap,
        outsideOrbPoints,
        maxAnchorGap,
        orbRadiusDelta,
        cordLengthDelta
      };
    });

    console.log("Starter relation checks (actual rendered SVG paths)");
    if (!metrics.ok && metrics.reason) {
      console.log(`[FAIL] ${metrics.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Phases: ${metrics.phases}; finite=${metrics.finite}`);
    console.log(`Max tentacle-root → bell-rim gap: ${metrics.maxRootGap.toFixed(4)}px (limit 1px)`);
    console.log(`Lantern perimeter points outside bell fill: ${metrics.outsideOrbPoints} (expected 0)`);
    console.log(`Max anchor/apex/cord gap: ${metrics.maxAnchorGap.toFixed(4)}px (limit 1px)`);
    console.log(`Orb radius delta: ${metrics.orbRadiusDelta.toFixed(8)}px (expected 0)`);
    console.log(`Cord length delta: ${metrics.cordLengthDelta.toFixed(8)}px (limit 0.001px)`);
    console.log(metrics.ok ? "[PASS] starter scene relations" : "[FAIL] starter scene relations");
    if (!metrics.ok) process.exitCode = 1;
    if (errors.length) {
      console.log(`[FAIL] runtime errors: ${errors.join(" | ")}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
