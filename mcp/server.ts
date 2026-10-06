#!/usr/bin/env bun
/**
 * Bannerlord.Helper MCP Server
 * ---------------------------------------------------------------------------
 * Bannerlord.Helper (the `bh` CLI) is an interactive tool: every command that
 * touches a mod asks the human to pick one from an `@inquirer/search` prompt,
 * and the bundled `dist/bannerlord-helper.js` also trips over a tsup
 * treeshaking bug (`assignWith is not defined`) in `info`/`search`.
 *
 * This server therefore does NOT shell out to the CLI for mod-scoped work.
 * Instead it reuses Bannerlord.Helper's own library layer (`src/helper`,
 * `src/core`, `src/api`) and supplies the module selection as a normal tool
 * argument, so every tool is fully non-interactive and MCP-friendly.
 *
 * Run with Bun (the repo is TypeScript + ESM):
 *   bun run "F:\Program Files\Bannerlord.Helper\mcp\server.ts"
 *
 * IMPORTANT: stdout is the MCP transport channel. Never console.log() here -
 * diagnostics go to stderr only.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { nexusmodApi } from '../src/api/index'
import {
    choiceModuleTemplateFiles,
    normalizeTranslateOptions,
    writeExternalSubmoduleFile,
    writeExternalTranslationFile,
    writeLanguageDataFile,
    writeLanguageStringsFile,
    writeTranslationStringsFile,
} from '../src/core/index'
import {
    BannerlordHelperConfig,
    clearLanguagesDirectory,
    getLanguageTargetPath,
    getModuleDataFiles,
    getModuleDataItems,
    getNativeModules,
    getTranslationFilename,
    identifyModuleDataFile,
    restoreTranslationFilename,
    type NativeModuleOptions,
} from '../src/helper/index'
import { languageDictionary } from '../src/shared/index'
import { ensureDirectory, pathExist } from '../src/utils/index'

const PROJECT_ROOT = path.resolve(import.meta.dir, '..')
const CLI_ENTRY = path.join(PROJECT_ROOT, 'dist', 'bannerlord-helper.js')
const SERVER_NAME = 'bannerlord-helper'
const SERVER_VERSION = '0.3.1+mcp.1'

const MAX_LIST_ITEMS = 60
const DEFAULT_CLI_TIMEOUT_MS = 60_000
const MAX_CLI_TIMEOUT_MS = 600_000

const log = (message: string) => {
    process.stderr.write(`[bannerlord-helper-mcp] ${message}\n`)
}

// ---------------------------------------------------------------------------
// result helpers
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

const ok = (payload: unknown): ToolResult => ({
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
})

const fail = (message: string, detail?: unknown): ToolResult => ({
    content: [
        {
            type: 'text',
            text: JSON.stringify(detail === undefined ? { error: message } : { error: message, detail }, null, 2),
        },
    ],
    isError: true,
})

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------------------
// module + language resolution (replaces the interactive prompts)
// ---------------------------------------------------------------------------

let moduleCache: { at: number; modules: NativeModuleOptions[] } | undefined
const MODULE_CACHE_TTL_MS = 30_000

async function listLocalModules(force = false): Promise<NativeModuleOptions[]> {
    if (!force && moduleCache && Date.now() - moduleCache.at < MODULE_CACHE_TTL_MS) {
        return moduleCache.modules
    }

    const modules = await getNativeModules()
    moduleCache = { at: Date.now(), modules }
    return modules
}

function briefModule(module: NativeModuleOptions) {
    return {
        id: module.id,
        name: module.name,
        version: module.version,
        directory: module.directory,
        path: module.path,
        type: module.type,
        category: module.category,
        builtin: module.builtin,
        dependencies: module.dependencies,
    }
}

type ResolvedModule = { module: NativeModuleOptions } | { ambiguous: NativeModuleOptions[] } | { missing: string }

async function resolveModule(query: string): Promise<ResolvedModule> {
    const trimmed = (query ?? '').trim()
    if (!trimmed) return { missing: 'Module query is empty.' }

    const modules = await listLocalModules()
    const needle = trimmed.toLowerCase()

    // absolute / relative directory on disk wins over name matching
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
        const absolute = path.resolve(trimmed)
        const byPath = modules.find((item) => path.resolve(item.path).toLowerCase() === absolute.toLowerCase())
        if (byPath) return { module: byPath }

        if (fs.existsSync(path.join(absolute, 'SubModule.xml'))) {
            const directory = path.basename(absolute)
            return {
                module: {
                    id: directory,
                    name: directory,
                    builtin: false,
                    type: 'Community',
                    category: 'Singleplayer',
                    dependencies: [],
                    directory,
                    path: absolute,
                },
            }
        }
    }

    const byDirectoryOrId = modules.find(
        (item) => item.directory.toLowerCase() === needle || item.id.toLowerCase() === needle,
    )
    if (byDirectoryOrId) return { module: byDirectoryOrId }

    const byName = modules.find((item) => item.name.toLowerCase() === needle)
    if (byName) return { module: byName }

    const partial = modules.filter(
        (item) =>
            item.directory.toLowerCase().includes(needle) ||
            item.id.toLowerCase().includes(needle) ||
            item.name.toLowerCase().includes(needle),
    )
    if (partial.length === 1) return { module: partial[0] }
    if (partial.length > 1) return { ambiguous: partial.slice(0, MAX_LIST_ITEMS) }

    return { missing: `No installed module matched "${query}".` }
}

function moduleResolutionHint(resolved: ResolvedModule): ToolResult {
    if ('ambiguous' in resolved) {
        return fail('Module query is ambiguous, pass a more specific id, directory or absolute path.', {
            candidates: resolved.ambiguous.map((item) => ({
                id: item.id,
                name: item.name,
                directory: item.directory,
                path: item.path,
            })),
        })
    }

    return fail('module' in resolved ? 'unreachable' : resolved.missing, {
        hint: 'Call bh_list_local_modules to see every installed module.',
    })
}

function resolveLanguage(query: string | undefined, field: string) {
    if (!query) return { code: undefined as string | undefined }
    const record = languageDictionary.getLanguage(query)
    if (!record) {
        return { error: `Unsupported ${field} "${query}". Call bh_list_languages for valid codes and names.` }
    }

    return { code: record.code }
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

function toolListLanguages() {
    const languages = languageDictionary.getAllLanguages()
    return ok({ count: languages.length, languages })
}

function toolResolveLanguage(args: { query?: string }) {
    const query = (args.query ?? '').trim()
    if (!query) return fail('query is required.')

    const record = languageDictionary.getLanguage(query)
    if (!record) {
        return fail(`No supported language matched "${query}".`, {
            languages: languageDictionary.getAllNames(),
        })
    }

    return ok(record)
}

async function toolListLocalModules(args: { filter?: string; includeOfficial?: boolean }) {
    const modules = await listLocalModules(true)
    const needle = (args.filter ?? '').trim().toLowerCase()
    const wanted = needle
        ? modules.filter(
              (item) =>
                  item.id.toLowerCase().includes(needle) ||
                  item.name.toLowerCase().includes(needle) ||
                  item.directory.toLowerCase().includes(needle),
          )
        : modules

    const filtered = args.includeOfficial === true ? wanted : wanted.filter((item) => item.type !== 'Official')

    return ok({
        total: modules.length,
        matched: wanted.length,
        shown: Math.min(filtered.length, MAX_LIST_ITEMS),
        truncated: filtered.length > MAX_LIST_ITEMS,
        modules: filtered.slice(0, MAX_LIST_ITEMS).map(briefModule),
    })
}

async function toolSearchNexusmods(args: { keywords: string }) {
    const keywords = (args.keywords ?? '').trim()
    if (!keywords) return fail('keywords is required.')

    const results = await nexusmodApi.getModules(keywords)
    return ok({
        keywords,
        count: results.length,
        results: results.slice(0, MAX_LIST_ITEMS),
    })
}

async function toolModuleDetails(args: { module: string; keywords?: string; refresh?: boolean }) {
    const resolved = await resolveModule(args.module)
    if (!('module' in resolved)) return moduleResolutionHint(resolved)

    const { module } = resolved
    const config = new BannerlordHelperConfig()
    let stored: { id?: string | number } | undefined

    try {
        stored = config.read(module.path) as { id?: string | number } | undefined
    } catch {
        stored = undefined
    }

    if ((!stored?.id || args.refresh) && args.keywords) {
        const found = await nexusmodApi.getModules(args.keywords)
        const first = found[0]
        if (!first) return fail(`No Nexus Mods entry matched "${args.keywords}".`)

        config.write(module.path, first as never)
        stored = first
    }

    if (!stored?.id) {
        return fail('No Nexus Mods id is linked to this module yet.', {
            module: briefModule(module),
            hint: 'Pass `keywords` so the tool can look the module up on Nexus Mods and cache the id locally.',
        })
    }

    const page = await nexusmodApi.getModulePage(stored.id)
    return ok({ module: briefModule(module), nexusmodsId: stored.id, page })
}

type FileStat = { filename: string; entries: number; existingEntries: number; appendedEntries: number }

async function toolGenerateTemplate(args: { module: string; to?: string; force?: boolean }) {
    const resolved = await resolveModule(args.module)
    if (!('module' in resolved)) return moduleResolutionHint(resolved)

    const { module } = resolved
    const target = resolveLanguage(args.to, 'target language')
    if ('error' in target) return fail(target.error)

    const translateTo = target.code ?? 'EN'
    const moduleDataPath = `${module.path}\\ModuleData`
    const languagesPath = getLanguageTargetPath(moduleDataPath, translateTo)
    ensureDirectory(languagesPath)

    if (args.force) await clearLanguagesDirectory(languagesPath, 'xml')

    const files = getModuleDataFiles(moduleDataPath)
    if (files.length === 0) return fail(`No translatable ModuleData files found in ${moduleDataPath}.`)

    const stats: FileStat[] = []
    const filenameDictionary = new Map<string, string>()

    for (const file of files) {
        const filename = getTranslationFilename(file, translateTo)
        const items = getModuleDataItems(moduleDataPath, file)
        if (items.size === 0) {
            stats.push({ filename, entries: 0, existingEntries: 0, appendedEntries: 0 })
            continue
        }

        filenameDictionary.set(file, filename)
        const stat = writeLanguageStringsFile(`${languagesPath}\\${filename}`, translateTo, items)
        stats.push({
            filename,
            entries: stat.targetIds.length,
            existingEntries: stat.ids.length,
            appendedEntries: stat.appendIds.length,
        })
    }

    if (translateTo !== 'EN') {
        const standardFiles = files.map((item) => filenameDictionary.get(item)).filter(Boolean) as string[]
        writeLanguageDataFile(languagesPath, translateTo, standardFiles)
    }

    const totalTarget = stats.reduce((sum, item) => sum + item.entries, 0)
    const totalAppended = stats.reduce((sum, item) => sum + item.appendedEntries, 0)

    return ok({
        module: briefModule(module),
        targetLanguage: translateTo,
        outputDirectory: languagesPath,
        forced: Boolean(args.force),
        filesScanned: files.length,
        filesWritten: stats.filter((item) => item.entries > 0).length,
        entriesTargeted: totalTarget,
        entriesAppended: totalAppended,
        stats,
    })
}

async function toolTranslateModule(args: {
    module: string
    to: string
    from?: string
    prefix?: string
    force?: boolean
    engine?: string
}) {
    const resolved = await resolveModule(args.module)
    if (!('module' in resolved)) return moduleResolutionHint(resolved)

    const { module } = resolved
    const to = resolveLanguage(args.to, 'target language')
    if ('error' in to) return fail(to.error)

    const from = resolveLanguage(args.from ?? 'EN', 'source language')
    if ('error' in from) return fail(from.error)

    const normalize = normalizeTranslateOptions({
        engine: args.engine,
        target: to.code,
        source: from.code,
    })
    const translateEngine = normalize.translateEngine
    const translateFrom = normalize.translateFrom ?? 'EN'
    const translateTo = normalize.translateTo ?? to.code

    const moduleDataPath = `${module.path}\\ModuleData`
    const sourcePath = getLanguageTargetPath(moduleDataPath, translateFrom)
    const targetPath = getLanguageTargetPath(moduleDataPath, translateTo)
    ensureDirectory(targetPath)

    if (args.force) await clearLanguagesDirectory(targetPath, 'xml')

    const files = await choiceModuleTemplateFiles(sourcePath, translateFrom)
    if (files.length === 0) return fail(`No translation template files found in ${sourcePath}.`)

    const stats: Array<{ filename: string; status: number; targetIds?: number; appendIds?: number }> = []
    const filenameDictionary = new Map<string, string>()

    for (const file of files) {
        const filename = getTranslationFilename(restoreTranslationFilename(file), translateTo)
        if (!pathExist(`${sourcePath}\\${file}`)) {
            stats.push({ filename, status: 404 })
            continue
        }

        filenameDictionary.set(file, filename)

        try {
            const stat = await writeTranslationStringsFile(`${sourcePath}\\${file}`, `${targetPath}\\${filename}`, {
                engine: translateEngine,
                to: translateTo,
                from: translateFrom,
                prefix: args.prefix,
            })
            stats.push({ filename, status: 200, targetIds: stat.targetIds.length, appendIds: stat.appendIds.length })
        } catch (error) {
            log(`translate failed for ${file}: ${messageOf(error)}`)
            stats.push({ filename, status: 500 })
        }
    }

    const standardFiles = files.map((item) => filenameDictionary.get(item)).filter(Boolean) as string[]
    if (standardFiles.length > 0) writeLanguageDataFile(targetPath, translateTo, standardFiles)

    return ok({
        module: briefModule(module),
        engine: translateEngine,
        from: translateFrom,
        to: translateTo,
        prefix: args.prefix ?? '',
        outputDirectory: targetPath,
        filesAttempted: files.length,
        filesSucceeded: stats.filter((item) => item.status === 200).length,
        filesFailed: stats.filter((item) => item.status !== 200).length,
        stats,
    })
}

async function toolExternalTranslation(args: {
    module: string
    to: string
    from?: string
    prefix?: string
    force?: boolean
    engine?: string
}) {
    const resolved = await resolveModule(args.module)
    if (!('module' in resolved)) return moduleResolutionHint(resolved)

    const { module } = resolved
    const to = resolveLanguage(args.to, 'target language')
    if ('error' in to) return fail(to.error)

    const from = resolveLanguage(args.from ?? 'EN', 'source language')
    if ('error' in from) return fail(from.error)

    const normalize = normalizeTranslateOptions({
        engine: args.engine,
        target: to.code,
        source: from.code,
    })
    const translateEngine = normalize.translateEngine
    const translateFrom = normalize.translateFrom ?? 'EN'
    const translateTo = normalize.translateTo ?? to.code

    const moduleDataPath = `${module.path}\\ModuleData`
    const files = getModuleDataFiles(moduleDataPath)
    if (files.length === 0) return fail(`No translatable ModuleData files found in ${moduleDataPath}.`)

    const targetModulePath = path.resolve(module.path, `../${path.basename(module.path)} ${translateTo}`)
    ensureDirectory(targetModulePath)

    writeExternalSubmoduleFile(
        module.path,
        targetModulePath,
        { ...module, files } as never,
        translateTo,
    )

    const targetModuleDataPath = `${targetModulePath}\\ModuleData`
    ensureDirectory(targetModuleDataPath)

    if (args.force) await clearLanguagesDirectory(targetModuleDataPath, 'xslt')

    const stats: Array<{ filename: string; status: number; targetIds?: number; appendIds?: number }> = []

    for (const file of files) {
        const items = getModuleDataItems(moduleDataPath, file)
        const filename = [...file.split('.').slice(0, -1), 'xslt'].join('.')

        try {
            const stat = await writeExternalTranslationFile(`${targetModuleDataPath}\\${filename}`, items, {
                engine: translateEngine,
                to: translateTo,
                from: translateFrom,
                prefix: args.prefix,
            })
            stats.push({ filename, status: 200, targetIds: stat.targetIds.length, appendIds: stat.appendIds.length })
        } catch (error) {
            log(`external translation failed for ${file}: ${messageOf(error)}`)
            stats.push({ filename, status: 500 })
        }
    }

    return ok({
        module: briefModule(module),
        engine: translateEngine,
        from: translateFrom,
        to: translateTo,
        outputModuleDirectory: targetModulePath,
        filesAttempted: files.length,
        filesSucceeded: stats.filter((item) => item.status === 200).length,
        filesFailed: stats.filter((item) => item.status !== 200).length,
        stats,
    })
}

async function toolIdentifier(args: { module: string; dryRun?: boolean }) {
    const resolved = await resolveModule(args.module)
    if (!('module' in resolved)) return moduleResolutionHint(resolved)

    const { module } = resolved
    const moduleDataPath = `${module.path}\\ModuleData`
    const files = getModuleDataFiles(moduleDataPath)
    if (files.length === 0) return fail(`No ModuleData files found in ${moduleDataPath}.`)

    if (args.dryRun) {
        const preview = files.map((file) => {
            const items = getModuleDataItems(moduleDataPath, file)
            const total = [...items.values()].reduce((sum, list) => sum + list.length, 0)
            return { filename: file, entries: total }
        })

        return ok({
            module: briefModule(module),
            dryRun: true,
            filesScanned: files.length,
            filesWithEntries: preview.filter((item) => item.entries > 0).length,
            preview: preview.slice(0, MAX_LIST_ITEMS),
        })
    }

    const stats: Array<{ filename: string; successCount: number; noopCount: number; failedCount: number }> = []
    for (const file of files) {
        const items = getModuleDataItems(moduleDataPath, file)
        if (items.size === 0) continue

        const record = identifyModuleDataFile(moduleDataPath, file, items)
        stats.push({ filename: file, ...record })
    }

    return ok({
        module: briefModule(module),
        filesScanned: files.length,
        filesChanged: stats.filter((item) => item.successCount > 0).length,
        entriesFixed: stats.reduce((sum, item) => sum + item.successCount, 0),
        entriesAlreadyIdentified: stats.reduce((sum, item) => sum + item.noopCount, 0),
        entriesFailed: stats.reduce((sum, item) => sum + item.failedCount, 0),
        stats,
    })
}

function toolRunCli(args: { args?: string[]; timeoutMs?: number }) {
    const cliArgs = Array.isArray(args.args) ? args.args.map(String) : []
    const timeoutMs = Math.min(Math.max(args.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS, 1_000), MAX_CLI_TIMEOUT_MS)

    if (!fs.existsSync(CLI_ENTRY)) {
        return Promise.resolve(
            fail(`Bundled CLI entry not found at ${CLI_ENTRY}.`, { hint: 'Run `npm run build` in the project root.' }),
        )
    }

    return new Promise<ToolResult>((resolve) => {
        const child = spawn(process.env.BANNERLORD_HELPER_NODE ?? 'node', [CLI_ENTRY, ...cliArgs], {
            cwd: PROJECT_ROOT,
            windowsHide: true,
        })

        let stdout = ''
        let stderr = ''
        let settled = false

        const finish = (result: ToolResult) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }

        const timer = setTimeout(() => {
            child.kill()
            finish(
                fail(`CLI timed out after ${timeoutMs} ms.`, {
                    hint: 'Interactive commands such as info/generate/translate cannot run headless - use the dedicated tools instead.',
                    stdout: stdout.slice(-4000),
                    stderr: stderr.slice(-4000),
                }),
            )
        }, timeoutMs)

        child.stdout?.on('data', (chunk) => {
            stdout += String(chunk)
        })
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk)
        })
        child.on('error', (error) => finish(fail(`Failed to spawn the CLI: ${messageOf(error)}`)))
        child.on('close', (code) =>
            finish(
                ok({
                    exitCode: code,
                    args: cliArgs,
                    stdout: stdout.slice(-8000),
                    stderr: stderr.slice(-4000),
                }),
            ),
        )
    })
}

// ---------------------------------------------------------------------------
// tool registry
// ---------------------------------------------------------------------------

const MODULE_ARG = {
    type: 'string',
    description:
        'Installed module to operate on: module id, folder name, display name, or an absolute module directory path. Call bh_list_local_modules first if unsure.',
} as const

const LANGUAGE_ARG = {
    type: 'string',
    description: 'Language code or name, e.g. CNs, "Chinese Simplified", cns, JA. Call bh_list_languages for the list.',
} as const

const TOOLS = [
    {
        name: 'bh_list_languages',
        description:
            'List every language supported by Bannerlord.Helper together with its code, English name, native name and translation file suffix.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => toolListLanguages(),
    },
    {
        name: 'bh_resolve_language',
        description:
            'Resolve a loosely typed language query (code, English name or native name) into the canonical Bannerlord.Helper language record.',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Language code or name to resolve.' } },
            required: ['query'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) => toolResolveLanguage(args as { query?: string }),
    },
    {
        name: 'bh_list_local_modules',
        description:
            'Scan the local Bannerlord installation and list installed modules (id, name, version, folder, path, dependencies). Use this to discover valid values for the `module` argument.',
        inputSchema: {
            type: 'object',
            properties: {
                filter: { type: 'string', description: 'Optional case-insensitive substring filter.' },
                includeOfficial: {
                    type: 'boolean',
                    default: false,
                    description: 'Include official game modules in the result.',
                },
            },
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) =>
            toolListLocalModules(args as { filter?: string; includeOfficial?: boolean }),
    },
    {
        name: 'bh_search_nexusmods',
        description:
            'Search Nexus Mods for Mount & Blade II: Bannerlord modules by keywords and return matching mods with ids, authors, versions and URLs. Uses the official Nexus Mods GraphQL API, so a personal API key must be present in the NEXUS_API_KEY environment variable.',
        inputSchema: {
            type: 'object',
            properties: { keywords: { type: 'string', description: 'Search keywords, e.g. "Diplomacy".' } },
            required: ['keywords'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) => toolSearchNexusmods(args as { keywords: string }),
    },
    {
        name: 'bh_module_details',
        description:
            'Fetch Nexus Mods metadata for an installed module. The Nexus id is read from the local .bh config; pass `keywords` to look it up and cache it when missing. Requires NEXUS_API_KEY, same as bh_search_nexusmods.',
        inputSchema: {
            type: 'object',
            properties: {
                module: MODULE_ARG,
                keywords: { type: 'string', description: 'Keywords used to look the module up on Nexus Mods.' },
                refresh: {
                    type: 'boolean',
                    default: false,
                    description: 'Re-query Nexus Mods and overwrite the cached config.',
                },
            },
            required: ['module'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) =>
            toolModuleDetails(args as { module: string; keywords?: string; refresh?: boolean }),
    },
    {
        name: 'bh_generate_template',
        description:
            'Generate the translation template (Languages/<code>/std_*.xml) for a module from its ModuleData XML files, mirroring `bh generate`.',
        inputSchema: {
            type: 'object',
            properties: {
                module: MODULE_ARG,
                to: { ...LANGUAGE_ARG, default: 'EN', description: 'Target language of the template. Defaults to EN.' },
                force: {
                    type: 'boolean',
                    default: false,
                    description: 'Delete existing .xml templates in the target directory before writing.',
                },
            },
            required: ['module'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) =>
            toolGenerateTemplate(args as { module: string; to?: string; force?: boolean }),
    },
    {
        name: 'bh_translate_module',
        description:
            'Translate an existing in-module translation template into another language and write it into the module, mirroring `bh translate`.',
        inputSchema: {
            type: 'object',
            properties: {
                module: MODULE_ARG,
                to: LANGUAGE_ARG,
                from: { ...LANGUAGE_ARG, default: 'EN', description: 'Source language. Defaults to EN.' },
                prefix: { type: 'string', description: 'Optional prefix prepended to every translated string.' },
                force: {
                    type: 'boolean',
                    default: false,
                    description: 'Delete existing .xml files in the target directory before writing.',
                },
                engine: {
                    type: 'string',
                    enum: ['microsoft', 'google', 'deeplx'],
                    default: 'microsoft',
                    description: 'Translation engine.',
                },
            },
            required: ['module', 'to'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) =>
            toolTranslateModule(args as { module: string; to: string; from?: string; prefix?: string; force?: boolean; engine?: string }),
    },
    {
        name: 'bh_create_external_translation',
        description:
            'Create an external translation module (a separate "<Module> <Lang>" folder plus XSLT patches), mirroring `bh external`.',
        inputSchema: {
            type: 'object',
            properties: {
                module: MODULE_ARG,
                to: LANGUAGE_ARG,
                from: { ...LANGUAGE_ARG, default: 'EN', description: 'Source language. Defaults to EN.' },
                prefix: { type: 'string', description: 'Optional prefix prepended to every translated string.' },
                force: { type: 'boolean', default: false, description: 'Delete existing .xslt files before writing.' },
                engine: {
                    type: 'string',
                    enum: ['microsoft', 'google', 'deeplx'],
                    default: 'microsoft',
                    description: 'Translation engine.',
                },
            },
            required: ['module', 'to'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) =>
            toolExternalTranslation(
                args as { module: string; to: string; from?: string; prefix?: string; force?: boolean; engine?: string },
            ),
    },
    {
        name: 'bh_identifier',
        description:
            'Fill in and repair the {=identifier} translation keys inside a module\'s ModuleData XML files, mirroring `bh identifier`. Set dryRun to preview without writing.',
        inputSchema: {
            type: 'object',
            properties: {
                module: MODULE_ARG,
                dryRun: {
                    type: 'boolean',
                    default: false,
                    description: 'Only count translatable entries without modifying any file.',
                },
            },
            required: ['module'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) => toolIdentifier(args as { module: string; dryRun?: boolean }),
    },
    {
        name: 'bh_run_cli',
        description:
            'Escape hatch: run the bundled `bh` CLI with raw arguments. Only non-interactive invocations work headlessly (e.g. ["language"], ["--version"], ["--help"]).',
        inputSchema: {
            type: 'object',
            properties: {
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Raw CLI arguments, e.g. ["language", "cns"].',
                },
                timeoutMs: {
                    type: 'number',
                    default: DEFAULT_CLI_TIMEOUT_MS,
                    description: `Timeout in milliseconds (max ${MAX_CLI_TIMEOUT_MS}).`,
                },
            },
            required: ['args'],
            additionalProperties: false,
        },
        handler: (args: Record<string, unknown>) => toolRunCli(args as { args?: string[]; timeoutMs?: number }),
    },
] as const

// ---------------------------------------------------------------------------
// server wiring
// ---------------------------------------------------------------------------

const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((item) => item.name === request.params.name)
    if (!tool) {
        return fail(`Unknown tool "${request.params.name}".`)
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    try {
        const result = await (tool.handler as (input: Record<string, unknown>) => Promise<ToolResult> | ToolResult)(args)
        return result
    } catch (error) {
        log(`${tool.name} failed: ${messageOf(error)}`)
        return fail(`${tool.name} failed: ${messageOf(error)}`)
    }
})

async function main() {
    await server.connect(new StdioServerTransport())
    log(`ready (project root: ${PROJECT_ROOT})`)
}

main().catch((error) => {
    log(`fatal startup error: ${messageOf(error)}`)
    process.exit(1)
})
