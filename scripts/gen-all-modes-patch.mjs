#!/usr/bin/env node
/**
 * gen-all-modes-patch.mjs
 *
 * 生成 all-modes.patch.yml：把 DSH 出厂预设（standard / ptc / minimal / cordis）
 * 里的 PowerShell shell 工具行替换成 `dsh-manual-bg/tool`（可一键转后台的 run 工具）。
 *
 * 做法：从各 preset.patch.yml 取出 preset 行（去掉 insert 缩进层）→ 替换工具行 →
 *       作为「按 id 覆盖 config」的 patch 行写入覆盖层。
 *
 * 用法：
 *   node scripts/gen-all-modes-patch.mjs
 *
 * 环境变量：
 *   DSH_WEB_PRESETS_DIR  dsh-web-app 的 presets 目录（默认自动解析 @deepseek-ai/dsh-web-app）
 *   DSH_HOME             DSH 数据目录（默认 ~/.dsh）
 *   DSH_ALL_MODES_OUT    覆盖层输出路径（默认 $DSH_HOME/profiles/web/all-modes.patch.yml）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const FILES = ['standard.patch.yml', 'ptc.patch.yml', 'minimal.patch.yml', 'cordis.patch.yml'];
const TOOL_NAME = 'dsh-manual-bg/tool';

/** 向上找包含 package.json 的包根目录。 */
function findPackageRoot(entry) {
  let dir = path.dirname(entry);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`无法定位包根目录: ${entry}`);
    dir = parent;
  }
}

/** 解析 dsh-web-app 的 presets 目录。 */
function resolvePresetsDir() {
  if (process.env.DSH_WEB_PRESETS_DIR) return process.env.DSH_WEB_PRESETS_DIR;
  try {
    return path.join(path.dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets');
  } catch {
    /* 该包可能未导出 ./package.json，退回主入口 */
  }
  const root = findPackageRoot(require.resolve('@deepseek-ai/dsh-web-app'));
  return path.join(root, 'presets');
}

const PRESET_DIR = resolvePresetsDir();
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const OUT =
  process.env.DSH_ALL_MODES_OUT || path.join(DSH_HOME, 'profiles', 'web', 'all-modes.patch.yml');

/** 把一段行块整体左移 n 个空格。 */
function dedent(lines, n) {
  const pad = ' '.repeat(n);
  return lines.map((l) => (l.startsWith(pad) ? l.slice(n) : l));
}

/** 替换原生 tool-pwsh 行（id: tool-pwsh / name: '@deepseek-ai/dsh-tool-pwsh'）。 */
function replacePwshRow(lines) {
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- id: tool-pwsh\s*$/.test(lines[i])) continue;
    const row = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^\s*- id:/.test(lines[j])) break;
      row.push(lines[j]);
    }
    const nameIdx = row.findIndex((l) => /^\s*name:\s*/.test(l));
    if (nameIdx === -1) continue;
    row[nameIdx] = row[nameIdx].replace(/name:\s*'.*'/, `name: '${TOOL_NAME}'`);
    lines.splice(i + 1, row.length, ...row);
    changed++;
  }
  return changed;
}

/** 替换 persistent-pwsh 行（含 config 块整体替换为最小 row）。 */
function replacePersistentPwshRow(lines) {
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- id: persistent-pwsh\s*$/);
    if (!m) continue;
    const indent = m[1];
    let end = i + 1;
    for (; end < lines.length; end++) {
      const lm = lines[end].match(/^(\s*)- id:/);
      if (lm && lm[1].length <= indent.length) break;
    }
    const block = lines.slice(i, end);
    const disabledLine = block.find((l) => /^\s*disabled:\s*/.test(l));
    const replacement = [
      `${indent}- id: tool-run`,
      `${indent}  name: '${TOOL_NAME}'`,
      ...(disabledLine !== undefined ? [disabledLine] : []),
    ];
    lines.splice(i, end - i, ...replacement);
    changed++;
  }
  return changed;
}

const blocks = [];
let totalChanged = 0;
for (const file of FILES) {
  const filePath = path.join(PRESET_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.warn(`[skip] 找不到预设文件: ${filePath}`);
    continue;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {4}- id: preset-/.test(l));
  if (start === -1) throw new Error(`找不到 preset 行: ${filePath}`);
  // 出厂 preset 文件都是「单预设 + config 到文件末尾」，取出后去掉 insert 缩进（-4）
  const block = dedent(lines.slice(start), 4);
  const changed = replacePwshRow(block) + replacePersistentPwshRow(block);
  totalChanged += changed;
  const presetId = block[0].match(/- id: (preset-\S+)/)[1];
  blocks.push({ file, presetId, changed, text: block.join('\n').replace(/\s+$/, '') });
  console.log(`${file}: ${presetId} 工具行替换 ${changed} 处`);
}

if (blocks.length === 0) throw new Error('没有可处理的出厂预设，检查 DSH_WEB_PRESETS_DIR');

const out = [
  '# ==========================================================================',
  '# dsh-manual-bg 全模式覆盖层（生成物，勿手改）。',
  '# 生成器：node scripts/gen-all-modes-patch.mjs',
  '# 作用：把出厂预设（standard/ptc/minimal/cordis）的 PowerShell shell 工具行',
  '#       换成 dsh-manual-bg/tool —— 可在 UI 里一键转后台的 run 工具。',
  '# 挂载：dsh web --patch <本文件>（重启生效）。',
  '# ==========================================================================',
  ...blocks.map((b) => b.text),
  '',
];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n\n'), 'utf8');
console.log(`\n写出: ${OUT} (${fs.statSync(OUT).size} 字节，共替换 ${totalChanged} 处)`);
