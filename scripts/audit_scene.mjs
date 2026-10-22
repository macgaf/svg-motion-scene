#!/usr/bin/env node
/**
 * Generic browser audit for a single-file animated SVG page.
 *
 * This checks delivery and interaction contracts. It does NOT prove the scene's
 * semantic, physical or visual correctness; those checks must be derived for
 * each scene from the rendered DOM and screenshots.
 *
 * Usage:
 *   node audit_scene.mjs <scene.html> [--shots <directory>]
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const VIEWPORTS = [
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "desktop", width: 1440, height: 900 }
];

function usage(message) {
  if (message) console.error(`错误：${message}\n`);
  console.error("用法：node audit_scene.mjs <scene.html> [--shots <directory>]");
  process.exit(2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage();
  const file = path.resolve(args[0]);
  let shots = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--shots") {
      if (!args[i + 1]) usage("--shots 缺少目录参数");
      shots = path.resolve(args[i + 1]);
      i += 1;
    } else {
      usage(`未知参数：${args[i]}`);
    }
  }
  return { file, shots };
}

function loadPlaywright() {
  const candidates = ["playwright", "playwright-core"];
  for (const name of candidates) {
    try {
      return require(name);
    } catch {
      // Continue: the package may be installed globally.
    }
  }
  let globalRoot = "";
  try {
    globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    // Fall through with the actionable error below.
  }
  for (const name of candidates) {
    if (!globalRoot) break;
    try {
      return require(path.join(globalRoot, name));
    } catch {
      // Continue.
    }
  }
  throw new Error(
    "未找到 Playwright，审计未执行。\n" +
      "开发期安装：npm install --no-save playwright && npx playwright install chromium\n" +
      "或安装到全局后，让 Node 能解析全局模块。\n" +
      "注意：Playwright 只是验证工具，交付 HTML 本身不能依赖它。"
  );
}

function isInlineResource(value) {
  return /^(?:#|data:|blob:|about:|javascript:)/i.test(String(value || "").trim());
}

function findExternalResourceHints(html) {
  const hits = [];
  const addHit = (label) => {
    if (!hits.includes(label)) hits.push(label);
  };
  const resourceTags = /<(script|img|image|use|source|video|audio|track|iframe|object|embed|input|link)\b([^>]*)>/gi;
  let match;
  while ((match = resourceTags.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (tag === "link") {
      const relMatch = attrs.match(/\brel\s*=\s*["']([^"']*)["']/i);
      const rel = relMatch ? relMatch[1].toLowerCase() : "";
      if (!/\b(stylesheet|preload|prefetch|modulepreload|preconnect|dns-prefetch|icon|manifest|apple-touch-icon|mask-icon)\b/.test(rel)) {
        continue;
      }
    }
    if (tag === "input") {
      const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i);
      if (!typeMatch || typeMatch[1].toLowerCase() !== "image") continue;
    }
    const attrMatches = [...attrs.matchAll(/\b(src|href|xlink:href|srcset|poster)\s*=\s*(["'])(.*?)\2/gi)];
    for (const attrMatch of attrMatches) {
      const name = attrMatch[1].toLowerCase();
      const value = attrMatch[3].trim();
      if (!value) continue;
      if (name === "srcset") {
        if (isInlineResource(value)) continue;
        const candidates = value.split(",").map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
        if (candidates.some((candidate) => !isInlineResource(candidate))) {
          addHit(`<${tag} srcset> 指向外部资源`);
        }
      } else if (!isInlineResource(value)) {
        addHit(`<${tag} ${name}> 指向外部资源`);
      }
    }
  }

  const cssUrl = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
  while ((match = cssUrl.exec(html)) !== null) {
    const value = (match[2] !== undefined ? match[2] : match[3] || "").trim();
    if (value && !isInlineResource(value)) {
      addHit("CSS url() 指向外部资源（含 @font-face/相对路径）");
    }
  }
  if (/@import\b/i.test(html)) addHit("CSS @import");

  const runtimeRules = [
    [/\bfetch\s*\(/i, "运行时 fetch()"],
    [/\bXMLHttpRequest\b/i, "运行时 XMLHttpRequest"],
    [/\bimport\s*\(/i, "动态 import()"],
    [/\bnew\s+(?:Image|Audio|Worker)\s*\(/i, "运行时创建资源对象"],
    [/<meta\b[^>]*http-equiv=["']refresh["']/i, "meta refresh 导航"]
  ];
  for (const [re, label] of runtimeRules) {
    if (re.test(html)) addHit(label);
  }
  return hits;
}

function staticChecks(html) {
  const checks = [];
  const add = (ok, id, detail) => checks.push({ status: ok ? "PASS" : "FAIL", id, detail });

  add(/<meta\b[^>]*name=["']viewport["'][^>]*content=["'][^"']*width\s*=\s*device-width/i.test(html), "viewport", "存在 width=device-width 的 viewport");
  add(/<html\b[^>]*\blang=["'][^"']+["']/i.test(html), "lang", "根元素有非空 lang");
  add(/<title>\s*\S[\s\S]*?<\/title>/i.test(html), "document-title", "页面有非空 <title>");
  add(/<svg\b/i.test(html), "inline-svg", "HTML 内包含 <svg>");
  add(html.includes("data-scene"), "scene-marker", "SVG 场景有 data-scene 契约标记");
  add(/prefers-reduced-motion/.test(html), "reduced-motion-branch", "包含 prefers-reduced-motion 分支（代码存在，行为由运行测试确认）");
  add(/visibilitychange/.test(html), "visibility-handler", "声明页面可见性处理（代码存在不等于生命周期已验证）");
  add(/data-motion-toggle/.test(html), "motion-toggle", "声明暂停/继续控件");

  const externalHints = findExternalResourceHints(html);
  add(externalHints.length === 0, "external-resources-static",
    externalHints.length ? `疑似外部依赖：${externalHints.join("、")}` : "静态扫描未发现外部资源；data:/片段引用视为内联");

  add(!/<(animate|animateTransform|animateMotion|set)\b/i.test(html), "single-time-source", "未使用 SMIL；本项目场景动画必须由同一 JavaScript 时钟驱动");
  return checks;
}

async function createPage(browser, url, viewport, reduceMotion) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    reducedMotion: reduceMotion ? "reduce" : "no-preference"
  });
  const page = await context.newPage();
  const runtime = { page, context, errors: [], badRequests: [] };
  page.on("pageerror", (error) => runtime.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtime.errors.push(`console.error: ${message.text()}`);
  });
  page.on("request", (request) => {
    const target = request.url();
    if (/^(data:|blob:|about:)/i.test(target)) return;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) return;
    const description = `${request.resourceType()}: ${target}`;
    if (!runtime.badRequests.includes(description)) runtime.badRequests.push(description);
  });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("[data-scene] [data-subject]", { timeout: 8000 });
  await page.waitForTimeout(120);
  const resourceEntries = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((entry) => entry.name));
  for (const target of resourceEntries) {
    if (/^(data:|blob:|about:)/i.test(target)) continue;
    if (target === url) continue;
    if (!runtime.badRequests.some((entry) => entry.endsWith(": " + target) || entry === target)) {
      runtime.badRequests.push(`performance resource: ${target}`);
    }
  }
  return runtime;
}

async function snapshotSvg(page) {
  return page.evaluate(() => {
    const svg = document.querySelector("[data-scene]");
    return svg ? svg.innerHTML : "";
  });
}

async function inspectAccessibility(page) {
  return page.evaluate(() => {
    const svg = document.querySelector("[data-scene]");
    if (!svg) return { ok: false, problems: ["missing [data-scene]"] };
    const problems = [];
    if (svg.getAttribute("role") !== "img") problems.push("SVG 缺少 role=img");
    const labelledby = (svg.getAttribute("aria-labelledby") || "").trim();
    if (!labelledby) problems.push("SVG 缺少 aria-labelledby");
    const ids = labelledby.split(/\s+/).filter(Boolean);
    const labels = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (labels.length !== ids.length) problems.push("aria-labelledby 引用了不存在的 ID");
    if (labels.some((node) => !node.textContent.trim())) problems.push("aria-labelledby 目标为空");
    const title = svg.querySelector(":scope > title");
    const desc = svg.querySelector(":scope > desc");
    if (!title || !title.textContent.trim()) problems.push("SVG 缺少非空 <title>");
    if (!desc || !desc.textContent.trim()) problems.push("SVG 缺少非空 <desc>");
    const button = document.querySelector("[data-motion-toggle]");
    const buttonName = button ? (button.textContent || "").trim() : "";
    if (!button) problems.push("缺少 [data-motion-toggle] 按钮");
    else if (!buttonName) problems.push("暂停按钮没有可读文字");
    if (button && button.tagName.toLowerCase() !== "button") problems.push("暂停控件不是原生 <button>");
    if (!document.documentElement.lang) problems.push("html 缺少 lang");
    return { ok: problems.length === 0, problems, buttonName };
  });
}

async function getButtonState(page) {
  return page.evaluate(() => {
    const button = document.querySelector("[data-motion-toggle]");
    if (!button) return null;
    const dataPlaying = button.getAttribute("data-playing");
    return {
      pressed: dataPlaying !== null ? dataPlaying : button.getAttribute("aria-pressed"),
      stateSource: dataPlaying !== null ? "data-playing" : "aria-pressed",
      text: (button.textContent || "").trim().replace(/\s+/g, " "),
      disabled: button.disabled
    };
  });
}

async function waitForScene(page) {
  await page.waitForFunction(() => {
    const scene = document.querySelector("[data-scene]");
    return scene && scene.getAttribute("aria-busy") !== "true";
  }, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(100);
}

async function countRunningSceneAnimations(page) {
  return page.evaluate(() => {
    const scene = document.querySelector("[data-scene]");
    if (!scene) return 0;
    return document.getAnimations()
      .filter((animation) => {
        const target = animation.effect && animation.effect.target;
        return animation.playState === "running" && target && scene.contains(target);
      })
      .length;
  });
}

async function inspectFit(page, label, phase, auditAvailable) {
  return page.evaluate(({ label, phase, auditAvailable }) => {
    if (auditAvailable && window.__svgSceneAudit) {
      window.__svgSceneAudit.renderAt(phase);
    }
    const stage = document.querySelector("[data-stage]") || document.querySelector("[data-scene]");
    const button = document.querySelector("[data-motion-toggle]");
    const scene = document.querySelector("[data-scene]");
    if (!stage || !button || !scene) return { label, ok: false, problems: ["缺少 stage / button / scene"] };
    const stageRect = stage.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const subjects = [...document.querySelectorAll("[data-subject]")].map((node) => node.getBoundingClientRect());
    if (subjects.length === 0) return { label, ok: false, problems: ["没有 [data-subject] 用于可见性检查"] };
    const union = subjects.reduce((acc, rect) => ({
      left: Math.min(acc.left, rect.left),
      top: Math.min(acc.top, rect.top),
      right: Math.max(acc.right, rect.right),
      bottom: Math.max(acc.bottom, rect.bottom)
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const problems = [];
    const finite = [union.left, union.top, union.right, union.bottom].every(Number.isFinite);
    if (!finite) problems.push("主体包围盒含非有限值");
    const inStage = union.left >= stageRect.left - 1 &&
      union.top >= stageRect.top - 1 &&
      union.right <= stageRect.right + 1 &&
      union.bottom <= stageRect.bottom + 1;
    if (!inStage) problems.push("主体超出舞台/页面边界");
    const inViewport = union.left >= -1 && union.top >= -1 &&
      union.right <= innerWidth + 1 && union.bottom <= innerHeight + 1;
    if (!inViewport) problems.push("主体超出视口");
    const overlapW = Math.max(0, Math.min(union.right, buttonRect.right) - Math.max(union.left, buttonRect.left));
    const overlapH = Math.max(0, Math.min(union.bottom, buttonRect.bottom) - Math.max(union.top, buttonRect.top));
    if (overlapW * overlapH > 0.5) problems.push("暂停控件与主体包围盒相交");
    const horizontalOverflow = document.documentElement.scrollWidth > innerWidth + 1;
    if (horizontalOverflow) problems.push("页面存在横向溢出");
    const safeMargin = Math.min(union.left - stageRect.left, union.top - stageRect.top,
      stageRect.right - union.right, stageRect.bottom - union.bottom);
    const safeMarginLimit = Math.max(8, Math.min(stageRect.width, stageRect.height) * 0.02);
    if (finite && safeMargin < safeMarginLimit) {
      problems.push(`主体安全边距不足（${safeMargin.toFixed(1)}px < ${safeMarginLimit.toFixed(1)}px）`);
    }
    const coverageW = union.right - union.left;
    const coverageH = union.bottom - union.top;
    if (finite && (coverageW < stageRect.width * 0.12 || coverageH < stageRect.height * 0.12)) {
      problems.push("主体占画面比例过小，可能不可读");
    }
    return {
      label,
      ok: problems.length === 0,
      problems,
      phase,
      union: { ...union, width: coverageW, height: coverageH },
      stage: { width: stageRect.width, height: stageRect.height },
      button: { width: buttonRect.width, height: buttonRect.height },
      safeMargin,
      safeMarginLimit,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth
    };
  }, { label, phase, auditAvailable });
}

async function testInteraction(browser, url) {
  const runtime = await createPage(browser, url, VIEWPORTS[2], false);
  const { page } = runtime;
  const records = [];
  const add = (status, id, detail) => records.push({ status, id, detail });
  await waitForScene(page);
  const auditAvailable = await page.evaluate(() => Boolean(window.__svgSceneAudit && typeof window.__svgSceneAudit.getState === "function"));
  const period = auditAvailable ? await page.evaluate(() => window.__svgSceneAudit.periodMs) : null;

  const initial = await getButtonState(page);
  add(initial && initial.pressed === "true" ? "PASS" : "FAIL", "default-playing",
    initial ? `初始 ${initial.stateSource}=${initial.pressed}，文字“${initial.text}”` : "未找到暂停按钮");

  const before = await snapshotSvg(page);
  await page.waitForTimeout(280);
  const after = await snapshotSvg(page);
  add(before !== after ? "PASS" : "FAIL", "motion-actually-advances", before !== after ? "间隔 280ms 后实际 SVG 状态变化" : "SVG 场景在 280ms 内没有变化");

  if (initial && initial.pressed === "true") {
    await page.locator("[data-motion-toggle]").click();
  }
  await page.waitForTimeout(80);
  const pausedState = await getButtonState(page);
  const pausedA = await snapshotSvg(page);
  const pausedClockA = auditAvailable
    ? await page.evaluate(() => window.__svgSceneAudit.getState())
    : null;
  await page.waitForTimeout(450);
  const pausedB = await snapshotSvg(page);
  const pausedClockB = auditAvailable
    ? await page.evaluate(() => window.__svgSceneAudit.getState())
    : null;
  add(pausedState && pausedState.pressed === "false" ? "PASS" : "FAIL", "pause-state",
    pausedState ? `点击后 ${pausedState.stateSource}=${pausedState.pressed}` : "按钮状态不可读");
  add(pausedA === pausedB ? "PASS" : "FAIL", "pause-freezes-scene",
    pausedA === pausedB ? "暂停 450ms 内实际 SVG 状态稳定" : "暂停后场景仍在变化");

  if (auditAvailable && pausedClockA && pausedClockB) {
    const frozenDelta = Math.abs(pausedClockB.timeMs - pausedClockA.timeMs);
    add(frozenDelta <= 2 ? "PASS" : "FAIL", "pause-clock-frozen",
      `暂停 450ms 的模拟时钟相位变化 ${frozenDelta.toFixed(1)}ms（容差 2ms）`);
  } else {
    add("SKIP", "pause-clock-frozen", "页面未提供审计钩子，无法从时钟确认暂停期间时间源冻结");
  }

  const runningCssAnimations = await countRunningSceneAnimations(page);
  add(runningCssAnimations === 0 ? "PASS" : "FAIL", "pause-all-time-sources",
    runningCssAnimations === 0 ? "未发现仍在运行的场景 CSS/WAAPI 动画" : `暂停后仍有 ${runningCssAnimations} 个场景动画运行`);

  // Resume from inside the page so phase continuity is not polluted by driver latency.
  let continuation = null;
  if (auditAvailable) {
    continuation = await page.evaluate(async () => {
      const audit = window.__svgSceneAudit;
      const button = document.querySelector("[data-motion-toggle]");
      const readPlaying = () => button.getAttribute("data-playing") ?? button.getAttribute("aria-pressed");
      const before = audit.getState();
      const buttonBefore = readPlaying();
      const wallStart = performance.now();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = audit.getState();
      return {
        before,
        after,
        elapsed: performance.now() - wallStart,
        buttonBefore,
        buttonAfter: readPlaying()
      };
    });
  } else {
    await page.locator("[data-motion-toggle]").click();
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(260);
  const resumedState = await getButtonState(page);
  const resumed = await snapshotSvg(page);
  add(resumedState && resumedState.pressed === "true" ? "PASS" : "FAIL", "resume-state",
    resumedState ? `恢复后 ${resumedState.stateSource}=${resumedState.pressed}` : "按钮状态不可读");
  add(resumed !== pausedA ? "PASS" : "FAIL", "resume-advances",
    resumed !== pausedA ? "恢复后实际 SVG 状态继续变化" : "恢复后场景状态没有变化");

  if (continuation && period) {
    const forwardDelta = ((continuation.after.timeMs - continuation.before.timeMs) % period + period) % period;
    const phaseError = Math.abs(forwardDelta - continuation.elapsed);
    const continuous = continuation.buttonBefore === "false" &&
      continuation.buttonAfter === "true" &&
      forwardDelta > 0 &&
      phaseError <= 250;
    add(continuous ? "PASS" : "FAIL", "resume-phase-continuity",
      `暂停相位 ${continuation.before.timeMs.toFixed(1)}ms；恢复后前两帧相位前进 ${forwardDelta.toFixed(1)}ms，实际耗时 ${continuation.elapsed.toFixed(1)}ms，误差 ${phaseError.toFixed(1)}ms（容差 250ms；重头播放会被拦截）`);
  } else {
    add("SKIP", "resume-phase-continuity", "页面未提供审计钩子，只能确认恢复后画面变化，无法证明从暂停相位继续");
  }

  await page.locator("[data-motion-toggle]").focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  const keyboardPaused = await getButtonState(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(120);
  const keyboardResumed = await getButtonState(page);
  const keyboardOk = keyboardPaused && keyboardPaused.pressed === "false" &&
    keyboardResumed && keyboardResumed.pressed === "true";
  add(keyboardOk ? "PASS" : "FAIL", "keyboard-toggle",
    keyboardPaused && keyboardResumed
      ? `空格后 ${keyboardPaused.stateSource}=${keyboardPaused.pressed}，再按后 ${keyboardResumed.stateSource}=${keyboardResumed.pressed}`
      : "键盘无法切换暂停状态");

  add(runtime.errors.length === 0 ? "PASS" : "FAIL", "runtime-errors",
    runtime.errors.length === 0 ? "无 pageerror / console.error" : runtime.errors.join(" | "));
  add(runtime.badRequests.length === 0 ? "PASS" : "FAIL", "external-resource-requests",
    runtime.badRequests.length === 0 ? "未发现外部资源请求（文件、网络或字体）" : `发生外部资源请求：${runtime.badRequests.join(", ")}`);

  await runtime.context.close();
  return records;
}

async function testViewport(browser, url, viewport, shotsDir) {
  const runtime = await createPage(browser, url, viewport, false);
  const { page } = runtime;
  await waitForScene(page);
  const auditAvailable = await page.evaluate(() => Boolean(window.__svgSceneAudit));
  const period = auditAvailable
    ? await page.evaluate(() => window.__svgSceneAudit.periodMs)
    : 12000;

  const initialPressed = (await getButtonState(page))?.pressed;
  if (initialPressed === "true") await page.locator("[data-motion-toggle]").click();
  await page.waitForTimeout(80);

  const phases = auditAvailable
    ? [0.12, 0.37, 0.62, 0.87].map((ratio) => Math.round(period * ratio))
    : [null];
  const fits = [];
  for (let i = 0; i < phases.length; i += 1) {
    fits.push(await inspectFit(page, viewport.name, phases[i], auditAvailable && phases[i] !== null));
  }

  const shot = shotsDir ? path.join(shotsDir, `${viewport.name}-${viewport.width}x${viewport.height}.png`) : null;
  if (shot) {
    if (auditAvailable) {
      await page.evaluate((t) => window.__svgSceneAudit.renderAt(t), phases[0] ?? 0);
    }
    await page.screenshot({ path: shot, fullPage: true });
  }

  const errors = runtime.errors.slice();
  await runtime.context.close();
  return { viewport, fits, auditAvailable, shot, errors, badRequests: runtime.badRequests };
}

async function testReducedMotion(browser, url) {
  const runtime = await createPage(browser, url, VIEWPORTS[0], true);
  const { page } = runtime;
  await waitForScene(page);
  const records = [];
  const add = (status, id, detail) => records.push({ status, id, detail });
  const state = await getButtonState(page);
  const a = await snapshotSvg(page);
  const runningAtLoad = await countRunningSceneAnimations(page);
  await page.waitForTimeout(500);
  const b = await snapshotSvg(page);
  const runningAfterWait = await countRunningSceneAnimations(page);
  const sceneStill = a === b && runningAtLoad === 0 && runningAfterWait === 0;
  add(sceneStill ? "PASS" : "FAIL", "reduced-motion-static",
    sceneStill
      ? "减少动态偏好下场景保持静止（DOM 稳定且无运行中的场景 CSS/WAAPI 动画）"
      : `减少动态偏好下场景没有完全静止（DOM变化=${a !== b}，CSS/WAAPI运行=${runningAtLoad}/${runningAfterWait}）`);
  add(state && !state.disabled ? "PASS" : "FAIL", "reduced-motion-controls",
    state ? `按钮状态 ${state.stateSource}=${state.pressed}，文字“${state.text}”` : "未找到按钮");
  add(state && state.pressed === "false" ? "PASS" : "FAIL", "reduced-motion-default-paused",
    state
      ? (state.pressed === "false" ? "减少动态偏好下默认暂停，提供显式播放入口" : "减少动态偏好下默认仍在播放")
      : "无法读取播放状态");

  if (state && state.pressed === "false") {
    await page.locator("[data-motion-toggle]").click();
    await page.waitForTimeout(280);
    const resumedState = await getButtonState(page);
    const c = await snapshotSvg(page);
    if (resumedState && resumedState.pressed === "true" && c !== b) {
      add("PASS", "reduced-motion-explicit-play", "用户显式点击后可播放");
    } else {
      add("FAIL", "reduced-motion-explicit-play", "减少动态下用户显式点击未能启动动画");
    }
  }

  add(runtime.errors.length === 0 ? "PASS" : "FAIL", "reduced-motion-errors",
    runtime.errors.length === 0 ? "无 pageerror / console.error" : runtime.errors.join(" | "));
  await runtime.context.close();
  return records;
}

async function testVisibilityRecovery(browser, url) {
  const runtime = await createPage(browser, url, VIEWPORTS[2], false);
  const { page } = runtime;
  await waitForScene(page);
  const auditAvailable = await page.evaluate(() => Boolean(window.__svgSceneAudit));
  if (!auditAvailable) {
    await runtime.context.close();
    return {
      records: [{
        status: "SKIP",
        id: "visibility-recovery",
        detail: "页面未提供 window.__svgSceneAudit，无法核对隐藏期间时钟是否追赶；需按场景验证可见性恢复"
      }],
      auditAvailable
    };
  }

  const before = await page.evaluate(() => window.__svgSceneAudit.getState());
  const during = await page.evaluate(async () => {
    const override = (hidden) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hidden
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible")
      });
    };
    override(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 750));
    const hiddenState = window.__svgSceneAudit.getState();
    override(false);
    document.dispatchEvent(new Event("visibilitychange"));
    const justVisible = window.__svgSceneAudit.getState();
    await new Promise((resolve) => setTimeout(resolve, 260));
    const later = window.__svgSceneAudit.getState();
    return { hiddenState, justVisible, later };
  });

  const records = [];
  const hiddenDelta = Math.abs(during.hiddenState.timeMs - before.timeMs) < 180;
  const noCatchup = Math.abs(during.justVisible.timeMs - during.hiddenState.timeMs) < 120;
  records.push({
    status: hiddenDelta ? "PASS" : "FAIL",
    id: "visibility-pauses-clock",
    detail: `隐藏 750ms 期间模拟时钟变化 ${Math.abs(during.hiddenState.timeMs - before.timeMs).toFixed(1)}ms（容差 180ms）`
  });
  records.push({
    status: noCatchup ? "PASS" : "FAIL",
    id: "visibility-no-catchup",
    detail: `恢复瞬间相位变化 ${Math.abs(during.justVisible.timeMs - during.hiddenState.timeMs).toFixed(1)}ms（容差 120ms；DOM 事件模拟，非真实标签页生命周期）`
  });
  records.push({
    status: "WARN",
    id: "visibility-test-fidelity",
    detail: "可见性通过 DOM 事件模拟；真实移动端后台挂起仍需在目标设备检查"
  });
  records.push({
    status: runtime.errors.length === 0 ? "PASS" : "FAIL",
    id: "visibility-errors",
    detail: runtime.errors.length === 0 ? "可见性切换无 runtime error" : runtime.errors.join(" | ")
  });
  await runtime.context.close();
  return { records, auditAvailable };
}

async function measureLoop(page) {
  return page.evaluate(() => {
    const audit = window.__svgSceneAudit;
    if (!audit) return { ok: false, reason: "missing audit" };
    const scene = document.querySelector("[data-scene]");
    if (!scene) return { ok: false, reason: "missing scene" };
    const period = audit.periodMs;
    const nodes = [...new Set([...scene.querySelectorAll("[data-animated], [data-animated] *")])]
      .filter((node) => node instanceof SVGGraphicsElement);

    function effectiveAlpha(node) {
      let alpha = parseFloat(getComputedStyle(node).opacity);
      if (!Number.isFinite(alpha)) alpha = 1;
      let parent = node.parentElement;
      while (parent && parent !== scene) {
        const parentAlpha = parseFloat(getComputedStyle(parent).opacity);
        if (Number.isFinite(parentAlpha)) alpha *= parentAlpha;
        parent = parent.parentElement;
      }
      const style = getComputedStyle(node);
      const fillOpacity = style.fill === "none" ? 0 : parseFloat(style.fillOpacity);
      const strokeOpacity = style.stroke === "none" ? 0 : parseFloat(style.strokeOpacity);
      alpha *= Math.max(Number.isFinite(fillOpacity) ? fillOpacity : 1, Number.isFinite(strokeOpacity) ? strokeOpacity : 1);
      return alpha;
    }

    function snapshot(time) {
      audit.renderAt(time);
      return nodes.map((node) => {
        const alpha = effectiveAlpha(node);
        const points = [];
        try {
          const total = node.getTotalLength();
          if (Number.isFinite(total) && total > 0) {
            for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
              const point = node.getPointAtLength(total * fraction);
              const matrix = node.getScreenCTM();
              if (!matrix) {
                points.push([NaN, NaN]);
                continue;
              }
              const transformed = new DOMPoint(point.x, point.y).matrixTransform(matrix);
              points.push([transformed.x, transformed.y]);
            }
          }
        } catch {
          // Fall back to the screen rectangle below.
        }
        if (points.length === 0) {
          const rect = node.getBoundingClientRect();
          points.push([rect.left, rect.top], [rect.right, rect.bottom]);
        }
        const rect = node.getBoundingClientRect();
        return {
          alpha,
          points,
          rect: [rect.left, rect.top, rect.width, rect.height]
        };
      });
    }

    function finiteSnapshots(snap) {
      return snap.every((node) =>
        Number.isFinite(node.alpha) &&
        node.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)) &&
        node.rect.every(Number.isFinite));
    }

    // 8-bit compositing: alpha below 1/255 is effectively invisible.
    const HIDDEN_ALPHA = 1 / 255;

    function step(a, b) {
      if (a.length !== b.length) return { point: Infinity, alpha: Infinity };
      let pointMax = 0;
      let alphaMax = 0;
      for (let i = 0; i < a.length; i += 1) {
        const bothHidden = a[i].alpha < HIDDEN_ALPHA && b[i].alpha < HIDDEN_ALPHA;
        if (!bothHidden) {
          alphaMax = Math.max(alphaMax, Math.abs(a[i].alpha - b[i].alpha));
          const count = Math.min(a[i].points.length, b[i].points.length);
          for (let p = 0; p < count; p += 1) {
            const dx = a[i].points[p][0] - b[i].points[p][0];
            const dy = a[i].points[p][1] - b[i].points[p][1];
            pointMax = Math.max(pointMax, Math.hypot(dx, dy));
          }
          for (let r = 0; r < 4; r += 1) {
            pointMax = Math.max(pointMax, Math.abs(a[i].rect[r] - b[i].rect[r]) * 0.25);
          }
        }
      }
      return { point: pointMax, alpha: alphaMax };
    }

    function velocityConsistency(before, middle, after) {
      if (before.length !== middle.length || middle.length !== after.length) {
        return { mismatch: Infinity, speed: 0 };
      }
      let maxMismatch = 0;
      let maxSpeed = 0;
      for (let i = 0; i < before.length; i += 1) {
        const allHidden = before[i].alpha < HIDDEN_ALPHA &&
          middle[i].alpha < HIDDEN_ALPHA && after[i].alpha < HIDDEN_ALPHA;
        if (allHidden) continue;
        const count = Math.min(before[i].points.length, middle[i].points.length, after[i].points.length);
        for (let p = 0; p < count; p += 1) {
          const beforeX = middle[i].points[p][0] - before[i].points[p][0];
          const beforeY = middle[i].points[p][1] - before[i].points[p][1];
          const afterX = after[i].points[p][0] - middle[i].points[p][0];
          const afterY = after[i].points[p][1] - middle[i].points[p][1];
          maxSpeed = Math.max(maxSpeed, Math.hypot(beforeX, beforeY), Math.hypot(afterX, afterY));
          maxMismatch = Math.max(maxMismatch, Math.hypot(afterX - beforeX, afterY - beforeY));
        }
      }
      return { mismatch: maxMismatch, speed: maxSpeed };
    }

    if (nodes.length === 0) return { ok: false, reason: "no [data-animated] geometry" };
    const dt = 1000 / 60;
    const times = [];
    for (let i = 0; i < 24; i += 1) times.push((period * i) / 24);
    const snapshots = times.map(snapshot);
    const finite = snapshots.every(finiteSnapshots);
    const beforeBoundary = snapshot(period - dt);
    const atBoundary = snapshot(0);
    const afterBoundary = snapshot(dt);
    const endpointDelta = step(atBoundary, snapshot(period));
    const boundaryDelta = step(beforeBoundary, atBoundary);
    const interiorDelta = step(atBoundary, afterBoundary);
    const velocity = velocityConsistency(beforeBoundary, atBoundary, afterBoundary);
    const positionLimit = Math.max(1, interiorDelta.point * 1.5);
    const alphaLimit = Math.max(0.02, interiorDelta.alpha * 2);
    const velocityLimit = Math.max(1, velocity.speed * 0.75);
    const positionOk = boundaryDelta.point <= positionLimit;
    const alphaOk = boundaryDelta.alpha <= alphaLimit;
    const velocityOk = velocity.mismatch <= velocityLimit;
    return {
      ok: finite && positionOk && alphaOk && velocityOk,
      finite,
      positionOk,
      alphaOk,
      velocityOk,
      periodMs: period,
      nodeCount: nodes.length,
      sampleCount: times.length,
      endpointPoint: endpointDelta.point,
      endpointAlpha: endpointDelta.alpha,
      boundaryPoint: boundaryDelta.point,
      boundaryAlpha: boundaryDelta.alpha,
      interiorPoint: interiorDelta.point,
      interiorAlpha: interiorDelta.alpha,
      positionLimit,
      alphaLimit,
      velocityMismatch: velocity.mismatch,
      velocitySpeed: velocity.speed,
      velocityLimit
    };
  });
}

async function testLoop(browser, url) {
  const runtime = await createPage(browser, url, VIEWPORTS[2], false);
  const { page } = runtime;
  await waitForScene(page);
  const auditAvailable = await page.evaluate(() => Boolean(window.__svgSceneAudit));
  if (!auditAvailable) {
    await runtime.context.close();
    return [{ status: "SKIP", id: "loop-continuity", detail: "未提供 window.__svgSceneAudit；需按场景另做循环边界采样" }];
  }
  if ((await getButtonState(page))?.pressed === "true") {
    await page.locator("[data-motion-toggle]").click();
  }
  await page.waitForTimeout(60);
  const metrics = await measureLoop(page);
  const records = [];
  if (!metrics.ok && metrics.reason) {
    records.push({ status: "FAIL", id: "loop-boundary-continuity", detail: metrics.reason });
  } else {
    records.push({
      status: metrics.ok ? "PASS" : "FAIL",
      id: "loop-boundary-continuity",
      detail: `周期 ${metrics.periodMs}ms；` +
        `边界位置步 ${metrics.boundaryPoint.toFixed(2)}px / 内部 ${metrics.interiorPoint.toFixed(2)}px（阈值 ${metrics.positionLimit.toFixed(2)}px）；` +
        `边界透明度差 ${metrics.boundaryAlpha.toFixed(4)}（阈值 ${metrics.alphaLimit.toFixed(4)}）；` +
        `有限差分速度 ${metrics.velocitySpeed.toFixed(2)}px/帧，不匹配 ${metrics.velocityMismatch.toFixed(2)}px（阈值 ${metrics.velocityLimit.toFixed(2)}px）；` +
        `均匀样本 ${metrics.sampleCount} × ${metrics.nodeCount} 节点，有限值=${metrics.finite}；` +
        `端点差 ${metrics.endpointPoint.toFixed(4)}px/α${metrics.endpointAlpha.toFixed(5)}（仅参考，renderAt 可能已归一化）`
    });
    if (!metrics.finite) records.push({ status: "FAIL", id: "loop-finite", detail: "采样中出现非有限几何值" });
  }
  records.push({
    status: "WARN",
    id: "loop-semantic-fidelity",
    detail: "循环位置与有限差分速度已检查；接触/遮挡/因果等场景语义仍需按场景断言与截图确认"
  });
  await runtime.context.close();
  return records;
}

function summarize(records) {
  const counts = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const record of records) counts[record.status] += 1;
  return counts;
}

async function main() {
  const { file, shots } = parseArgs(process.argv);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    usage(`文件不存在：${file}`);
  }
  if (!stat.isFile()) usage(`不是普通文件：${file}`);
  if (!/\.html?$/i.test(file)) usage("输入文件必须是 .html/.htm 单文件页面");
  if (shots) await fsp.mkdir(shots, { recursive: true });
  const html = fs.readFileSync(file, "utf8");
  const records = [];
  for (const check of staticChecks(html)) records.push(check);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const target = pathToFileURL(file);
  target.searchParams.set("audit", "1");
  const url = target.href;
  const screenshots = [];

  try {
    // Interaction suite (desktop, normal motion).
    records.push(...await testInteraction(browser, url));

    // Viewport fit and screenshots.
    for (const viewport of VIEWPORTS) {
      const result = await testViewport(browser, url, viewport, shots);
      if (result.shot) screenshots.push(result.shot);
      for (const fit of result.fits) {
        records.push({
          status: fit.ok ? "PASS" : "FAIL",
          id: `fit-${viewport.name}`,
          detail: `${viewport.width}×${viewport.height} ${fit.phase === null ? "当前帧" : `t=${fit.phase}ms`}：` +
            (fit.ok
              ? `主体在舞台内，安全边距 ${fit.safeMargin.toFixed(1)}px ≥ 阈值 ${fit.safeMarginLimit.toFixed(1)}px`
              : fit.problems.join("；"))
        });
      }
      for (const error of result.errors) records.push({ status: "FAIL", id: `runtime-${viewport.name}`, detail: error });
      for (const request of result.badRequests) records.push({ status: "FAIL", id: `external-resource-${viewport.name}`, detail: request });
      if (!result.auditAvailable) {
        records.push({ status: "SKIP", id: `phase-sweep-${viewport.name}`, detail: "未提供审计钩子，只检查了一个相位" });
      }
    }

    // Reduced motion and visibility.
    records.push(...await testReducedMotion(browser, url));
    const visibility = await testVisibilityRecovery(browser, url);
    records.push(...visibility.records);

    // Loop continuity.
    records.push(...await testLoop(browser, url));

    // Accessibility via browser.
    const runtime = await createPage(browser, url, VIEWPORTS[2], false);
    const accessibility = await inspectAccessibility(runtime.page);
    records.push({
      status: accessibility.ok ? "PASS" : "FAIL",
      id: "accessibility",
      detail: accessibility.ok ? "SVG role/title/desc/aria 与原生按钮通过" : accessibility.problems.join("；")
    });
    await runtime.context.close();
  } finally {
    await browser.close();
  }

  records.push({
    status: shotGuard(shots),
    id: "visual-screenshots",
    detail: shots ? `截图已生成，仍需人工查看：${screenshots.join("、")}` : "未生成截图；请加 --shots 并人工查看三种画幅"
  });
  records.push({
    status: "WARN",
    id: "semantic-scene-checks",
    detail: "通用脚本不验证部件语义、连接/包含/遮挡、物理约束和美术质量；这些必须按 verification.md 另写断言"
  });

  for (const record of records) {
    console.log(`[${record.status}] ${record.id}: ${record.detail}`);
  }
  const counts = summarize(records);
  console.log(`\nSummary: ${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.WARN} WARN, ${counts.SKIP} SKIP`);
  console.log("Note: a passing exit only means the generic contract checks passed; scene-specific checks still matter.");
  if (counts.FAIL > 0) process.exitCode = 1;
}

function shotGuard(shots) {
  return shots ? "WARN" : "SKIP";
}

main().catch((error) => {
  console.error(`\n审计失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
