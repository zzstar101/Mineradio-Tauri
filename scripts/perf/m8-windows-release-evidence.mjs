#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildM8WindowsReleaseEvidence,
	M8_WINDOWS_RELEASE_PROTOCOL,
} from "./m8-windows-release-evidence-model.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const defaultOutputPath = path.join(
	repoRoot,
	"output",
	"perf",
	"m8-windows-release-evidence.json",
);
const collectorScriptPath = path.join(
	repoRoot,
	"scripts",
	"perf",
	"m8-windows-release-collector.ps1",
);

export async function collectM8WindowsReleaseEvidence(options, collector) {
	const host = await collector.collectHost();
	const coldStarts = [];
	for (let run = 1; run <= M8_WINDOWS_RELEASE_PROTOCOL.coldStartRuns; run += 1) {
		coldStarts.push(await collector.collectColdStart({
			run,
			executablePath: options.executablePath,
			args: options.args ?? [],
			readyTimeoutSeconds: options.readyTimeoutSeconds ?? 30,
		}));
	}

	const steadyStateRuns = [];
	for (let run = 1; run <= M8_WINDOWS_RELEASE_PROTOCOL.sampleRuns; run += 1) {
		steadyStateRuns.push(await collector.collectSteadyState({
			run,
			executablePath: options.executablePath,
			args: options.args ?? [],
			readyTimeoutSeconds: options.readyTimeoutSeconds ?? 30,
			warmupSeconds: M8_WINDOWS_RELEASE_PROTOCOL.warmupSeconds,
			sampleSeconds: M8_WINDOWS_RELEASE_PROTOCOL.sampleSeconds,
			sampleIntervalMs: M8_WINDOWS_RELEASE_PROTOCOL.sampleIntervalMs,
		}));
	}

	return buildM8WindowsReleaseEvidence({
		capturedAt: options.capturedAt ?? new Date().toISOString(),
		git: options.git,
		host,
		target: {
			executablePath: path.resolve(options.executablePath),
			args: options.args ?? [],
		},
		coldStarts,
		steadyStateRuns,
		optionalMetrics: options.optionalMetrics,
		fieldValidation: options.fieldValidation,
	});
}

function commandText(command, args) {
	return execFileSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function collectGit() {
	const status = commandText("git", ["status", "--porcelain"]);
	return {
		commit: commandText("git", ["rev-parse", "HEAD"]),
		dirty: status.length > 0,
	};
}

function readJson(filePath) {
	return JSON.parse(readFileSync(filePath, "utf8"));
}

function manualEvidenceFromOptions(options) {
	if (!options.manualPath) return {};
	if (!existsSync(options.manualPath) || !statSync(options.manualPath).isFile()) {
		throw new Error(`manual evidence 不存在或不是文件: ${options.manualPath}`);
	}
	return readJson(options.manualPath);
}

export function parseM8WindowsReleaseArguments(argv) {
	const options = {
		args: [],
		executablePath: null,
		manualPath: null,
		outputPath: defaultOutputPath,
		packagePath: null,
		readyTimeoutSeconds: 30,
		strict: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--strict") {
			options.strict = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") return null;
		const value = argv[index + 1];
		if (!value) throw new Error(`${argument} 缺少值`);
		if (argument === "--exe") options.executablePath = path.resolve(value);
		else if (argument === "--arg") options.args.push(value);
		else if (argument === "--manual") options.manualPath = path.resolve(value);
		else if (argument === "--output") options.outputPath = path.resolve(value);
		else if (argument === "--package") options.packagePath = path.resolve(value);
		else if (argument === "--ready-timeout") {
			options.readyTimeoutSeconds = Number(value);
		} else throw new Error(`未知参数: ${argument}`);
		index += 1;
	}
	if (!options.executablePath) throw new Error("必须提供 --exe <MineRadio-Tauri.exe>");
	if (!Number.isFinite(options.readyTimeoutSeconds) || options.readyTimeoutSeconds <= 0) {
		throw new Error("--ready-timeout 必须是正数秒数");
	}
	return options;
}

function usage() {
	return `用法: bun scripts/perf/m8-windows-release-evidence.mjs --exe <path> [options]

  --arg <value>          传给应用的单个参数，可重复
  --manual <path>       GPU/frame 等人工或外部工具采集 JSON
  --package <path>      安装包或 release bundle，用于自动记录体积
  --output <path>       evidence 输出路径
  --ready-timeout <sec> 主窗口就绪超时，默认 30 秒
  --strict              Field Validation 未完成时返回非零
`;
}

function optionalMetricsFromOptions(options, manual) {
	if (options.packagePath) {
		if (!existsSync(options.packagePath) || !statSync(options.packagePath).isFile()) {
			throw new Error(`release package 不存在或不是文件: ${options.packagePath}`);
		}
	}
	return {
		gpuMemory: manual.gpuMemory ?? {
			status: "required-manual",
			note: "Windows 进程计数器无法可靠归属共享 GPU 内存，需 GPU 工具补证",
		},
		frameTime: manual.frameTime ?? {
			status: "required-manual",
			note: "需 release WebView2 frame telemetry 补证",
		},
		packageSize: options.packagePath
			? { status: "captured", bytes: statSync(options.packagePath).size }
			: manual.packageSize ?? {
				status: "pending",
				note: "未提供 --package",
			},
	};
}

function fieldValidationFromOptions(manual) {
	return manual.fieldValidation;
}

export function createUnsupportedCollector() {
	return {
		async collectHost() {
			return {
				platform: process.platform,
				release: os.release(),
				arch: process.arch,
			};
		},
		async collectColdStart() {
			throw new Error("M8 Windows release runner 只能在 Windows 上采集");
		},
		async collectSteadyState() {
			throw new Error("M8 Windows release runner 只能在 Windows 上采集");
		},
	};
}

function parseCollectorOutput(output, mode) {
	const text = String(output ?? "").trim();
	if (!text) throw new Error(`Windows ${mode} collector 未返回 JSON`);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(
			`Windows ${mode} collector 返回无效 JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function createWindowsPowerShellCollector(options = {}) {
	const execute = options.execute ?? ((args, executionOptions = {}) =>
		execFileSync(options.shell ?? "powershell.exe", args, {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: executionOptions.timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		}));
	const common = [
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		options.scriptPath ?? collectorScriptPath,
	];
	const invoke = (mode, input = {}) => {
		const args = [...common, "-Mode", mode];
		if (input.executablePath) {
			args.push("-ExecutablePath", input.executablePath);
			args.push(
				"-ArgumentsBase64",
				Buffer.from(JSON.stringify(input.args ?? []), "utf8").toString("base64"),
			);
		}
		for (const [flag, value] of [
			["-Run", input.run],
			["-ReadyTimeoutSeconds", input.readyTimeoutSeconds],
			["-WarmupSeconds", input.warmupSeconds],
			["-SampleSeconds", input.sampleSeconds],
			["-SampleIntervalMs", input.sampleIntervalMs],
		]) {
			if (value !== undefined) args.push(flag, String(value));
		}
		const durationSeconds =
			Number(input.readyTimeoutSeconds ?? 0) +
			Number(input.warmupSeconds ?? 0) +
			Number(input.sampleSeconds ?? 0) +
			30;
		return parseCollectorOutput(
			execute(args, { timeoutMs: Math.max(60_000, durationSeconds * 1_000) }),
			mode,
		);
	};

	return {
		async collectHost() {
			return invoke("host");
		},
		async collectColdStart(input) {
			return invoke("cold", input);
		},
		async collectSteadyState(input) {
			return invoke("steady", input);
		},
	};
}

async function main() {
	const options = parseM8WindowsReleaseArguments(process.argv.slice(2));
	if (!options) {
		process.stdout.write(usage());
		return;
	}
	if (!existsSync(options.executablePath)) {
		throw new Error(`目标程序不存在: ${options.executablePath}`);
	}
	const collector = process.platform === "win32"
		? createWindowsPowerShellCollector()
		: createUnsupportedCollector();
	const manual = manualEvidenceFromOptions(options);
	const evidence = await collectM8WindowsReleaseEvidence(
		{
			...options,
			git: collectGit(),
			optionalMetrics: optionalMetricsFromOptions(options, manual),
			fieldValidation: fieldValidationFromOptions(manual),
		},
		collector,
	);
	mkdirSync(path.dirname(options.outputPath), { recursive: true });
	writeFileSync(options.outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	console.log(`[m8-release-evidence] manifest: ${options.outputPath}`);
	console.log(`[m8-release-evidence] status: ${evidence.evaluation.status}`);
	if (options.strict && !evidence.evaluation.fieldValidated) process.exitCode = 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(
		`[m8-release-evidence] ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
