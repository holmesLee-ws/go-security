#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계(R2), 국내 근거·글로벌 비교 칸(R10), 출처 참조·조회일(R11), 경계·연결(R13), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교"];
const GO_AREAS = ["go-develop", "go-ai", "go-control", "go-hr", "go-project-management", "go-finance", "go-accounting", "go-scm", "go-valuation", "go-marketing"];
const STATUSES = ["확인", "부분", "미확인"];

function parseSources(text) {
  const sources = new Map();
  const problems = [];
  for (const line of text.split("\n")) {
    if (!/^\| (KR|GL)-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 8) { problems.push(`sources.md 칸 수 오류: ${cells[0]}`); continue; }
    const [id, name, org, url, checked, status, change, note] = cells;
    if (status !== "미확인" && !note) problems.push(`${id}: 확인 내용 없음`);
    if (sources.has(id)) problems.push(`sources.md 중복 id: ${id}`);
    if (!name || !org) problems.push(`${id}: 명칭·기관 없음`);
    const urls = url.match(/https:\/\/[^\s)>]+/g) || [];
    if (!urls.length) problems.push(`${id}: 공식 URL 없음`);
    const d = new Date(`${checked}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checked) || isNaN(d) || d.toISOString().slice(0, 10) !== checked || d > new Date()) problems.push(`${id}: 조회일 오류(실재하는 과거 날짜)`);
    if (!STATUSES.includes(status)) problems.push(`${id}: 확인 상태 값 오류 ${status}`);
    if (!["", "잦음"].includes(change)) problems.push(`${id}: 변동 칸은 빈칸 또는 잦음`);
    sources.set(id, { status });
  }
  return { sources, problems };
}

const refs = [];
function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    if (/^#{3,} /m.test(block.split("\n").slice(1).join("\n"))) problems.push(`${head}: 블록 안에 하위 제목(모듈은 ### 하나로)`);
    const m = head.match(/^([BPMOX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) { if (fields[f[1]]) problems.push(`${head}: 「${f[1]}」 중복`); fields[f[1]] = f[2]; }
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    for (const [name, prefix] of [["국내 근거", "KR-"], ["글로벌 비교", "GL-"]]) {
      const ids = (fields[name] || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!ids.some((x) => x.startsWith(prefix))) problems.push(`${id}: 「${name}」에 ${prefix} 출처 없음`);
      refs.push(...ids.map((x) => [id, x]));
    }
    if (fields["경계·연결"] && !GO_AREAS.some((a) => new RegExp(`(^|[^\\w-])${a}(?![\\w-])`).test(fields["경계·연결"]))) problems.push(`${id}: 경계·연결에 go-* 영역 이름 없음`);
    if (id.startsWith("X") && !fields["산출물 필수 항목"]) problems.push(`${id}: 「산출물 필수 항목」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, problems };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(x?html?|css|svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)$/i.test(f) || (/\.(m|c)?jsx?$|\.tsx$/i.test(f) && !allowedJs.test(f)));
}

// 튜터가 복사할 수 있는 마크업을 찾는다. 구축 기록(docs/build/)은 규칙 설명에 태그 이름을 적으므로 펜스 안만 본다.
function findTemplateMarkup(name, text) {
  const tag = /<(!doctype|html|svg|style|canvas|script)\b/i;
  if (!name.startsWith("docs/build/")) return tag.test(text) ? [name] : [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?(\1|$)/g)) if (tag.test(m[0])) return [name];
  return [];
}

function main() {
  const mapText = read("curriculum/map.md");
  const { modules, problems } = parseCurriculum(mapText);
  errors.push(...problems);
  const { sources, problems: sp } = parseSources(read("curriculum/sources.md"));
  errors.push(...sp);
  for (const [mod, ref] of refs) {
    if (!sources.has(ref)) errors.push(`${mod}: 없는 출처 ${ref}`);
    else if (sources.get(ref).status === "미확인") errors.push(`${mod}: 미확인 출처 참조 ${ref}`);
  }
  if (/\d+\s?조(의\s?\d+)?|\bArt(icle)?\.?\s?\d+|§/.test(mapText)) errors.push("map.md에 조문 번호 금지(sources.md에만 둔다)");
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => /\.md$/i.test(x) && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  const REQUIRED_ALLOW = ["Edit(/learner/state.json)", "Edit(/learner/log.md)", "Edit(/learner/studio/**/*.html)", "Edit(/learner/work/**)", "WebSearch", "WebFetch", "Bash(open learner/studio/*.html)", "Bash(xdg-open learner/studio/*.html)", 'Bash(start "" learner/studio/*.html)', "PowerShell(Start-Process learner/studio/*.html)"];
  try {
    const allow = JSON.parse(read(".claude/settings.json")).permissions?.allow || [];
    for (const r of REQUIRED_ALLOW) if (!allow.includes(r)) errors.push(`settings.json 필수 허용 없음: ${r}`);
    for (const r of allow) if (!REQUIRED_ALLOW.includes(r)) errors.push(`settings.json 목록 밖 허용: ${r}`);
  } catch {}
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 출처 ${sources.size}개, 파일 ${files.length}개 검사`);
}

main();
