#!/usr/bin/env node
/**
 * Start a new app from the starter:
 *
 *   pnpm create-app <name>          →  apps/<name>, package @spark/<name>
 *
 * Copies apps/starter (without node_modules and dist), renames the package and
 * the page title, picks the next free dev port, adds the app to the root
 * TypeScript project references and to .claude/launch.json, and prints what
 * to run next. The starter stays untouched so it is always a clean example.
 */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const APPS = path.join(repoRoot, 'apps');
const STARTER = path.join(APPS, 'starter');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: pnpm create-app <name>   (lowercase letters, digits and dashes)');
  process.exit(1);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function nextPort() {
  let max = 5174;
  for (const dir of await readdir(APPS)) {
    const file = path.join(APPS, dir, 'vite.config.ts');
    if (!(await exists(file))) continue;
    const m = /\|\|\s*(\d{4,5})/.exec(await readFile(file, 'utf8'));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function main() {
  const name = process.argv[2];
  if (!name) usage();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) usage(`"${name}" is not a valid app name.`);
  if (name === 'starter') usage('The starter is the template; pick another name.');
  const target = path.join(APPS, name);
  if (await exists(target)) usage(`apps/${name} already exists.`);
  if (!(await exists(STARTER))) usage('apps/starter is missing; nothing to copy from.');

  await mkdir(target, { recursive: true });
  await cp(STARTER, target, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src) });

  const port = await nextPort();
  const title = name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const pkgFile = path.join(target, 'package.json');
  const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
  pkg.name = `@spark/${name}`;
  pkg.description = `${title}, built with Spark Engine`;
  await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);

  const viteFile = path.join(target, 'vite.config.ts');
  await writeFile(viteFile, (await readFile(viteFile, 'utf8')).replace(/\|\|\s*\d{4,5}/, `|| ${port}`));

  const htmlFile = path.join(target, 'index.html');
  await writeFile(htmlFile, (await readFile(htmlFile, 'utf8')).replace('Spark Engine — Starter', `${title} — Spark Engine`));

  const sceneFile = path.join(target, 'src', 'scene.ts');
  await writeFile(sceneFile, (await readFile(sceneFile, 'utf8')).replace("name: 'starter'", `name: '${name}'`));

  // Root TypeScript references (pnpm typecheck) and the browser-pane launch configs.
  const tsFile = path.join(repoRoot, 'tsconfig.json');
  const ts = JSON.parse(await readFile(tsFile, 'utf8'));
  if (!ts.references.some((r) => r.path === `apps/${name}`)) ts.references.push({ path: `apps/${name}` });
  await writeFile(tsFile, `${JSON.stringify(ts, null, 2)}\n`);

  const launchFile = path.join(repoRoot, '.claude', 'launch.json');
  if (await exists(launchFile)) {
    const launch = JSON.parse(await readFile(launchFile, 'utf8'));
    if (!launch.configurations.some((c) => c.name === name)) {
      launch.configurations.push({ name, runtimeExecutable: 'pnpm', runtimeArgs: ['--filter', `@spark/${name}`, 'dev'], port, autoPort: true });
      await writeFile(launchFile, `${JSON.stringify(launch, null, 2)}\n`);
    }
  }

  console.log(`created apps/${name} (@spark/${name}) on port ${port}\n`);
  console.log('next:');
  console.log('  pnpm install                          # links the new package');
  console.log(`  pnpm --filter @spark/${name} dev      # http://localhost:${port}`);
  console.log(`  edit apps/${name}/src/scene.ts        # your scene; docs/guide/first-scene.md walks through it`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
