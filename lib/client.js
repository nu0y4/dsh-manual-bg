window.__ModuleLoader__.load({
	id: "dsh-manual-bg",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var jsx_runtime = require("react/jsx-runtime");
		var jsx = jsx_runtime.jsx;
		var jsxs = jsx_runtime.jsxs;

		// ── helpers ────────────────────────────────────────────────────────────
		/** Read the shell command out of a Tool block (start phase or settled result). */
		function readCommand(block) {
			var raw = null;
			if (block !== null && typeof block === "object") {
				if (block.kind === void 0) {
					if (block.phase === "start" && typeof block.argsRaw === "string") raw = block.argsRaw;
				} else if (block.kind === "tool-result" && block.call !== null && typeof block.call === "object") {
					raw = typeof block.call.argsRaw === "string" ? block.call.argsRaw : null;
				}
			}
			if (raw === null || raw === "") return "";
			try {
				var parsed = JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object" && typeof parsed.command === "string") return parsed.command;
				return raw;
			} catch {
				return raw;
			}
		}

		/** Concatenate the settled result's text blocks. */
		function readResultText(block) {
			var content = block !== null && typeof block === "object" && Array.isArray(block.content) ? block.content : [];
			var parts = [];
			for (var i = 0; i < content.length; i++) {
				var c = content[i];
				if (c !== null && typeof c === "object" && c.type === "text" && typeof c.text === "string") parts.push(c.text);
			}
			return parts.join("\n");
		}

		function firstLine(text) {
			var i = text.indexOf("\n");
			return i === -1 ? text : text.slice(0, i);
		}

		// ── styles ─────────────────────────────────────────────────────────────
		var S = {
			root: {
				display: "flex",
				flexDirection: "column",
				minWidth: 0,
				margin: "1px 0"
			},
			card: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				minWidth: 0,
				padding: "1px 4px",
				margin: "0 -4px",
				borderRadius: "4px",
				fontSize: "12px",
				lineHeight: "1.4",
				cursor: "pointer"
			},
			cmd: {
				flex: "1 1 auto",
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontFamily: "var(--dsw-font-mono, ui-monospace, Consolas, monospace)",
				fontSize: "11px",
				opacity: 0.9
			},
			cmdError: { color: "var(--dsw-alias-state-danger-primary, #e05555)" },
			spacer: { flex: "0 0 auto", width: "0px" },
			out: {
				margin: "2px 0 2px 4px",
				padding: "4px 8px",
				maxHeight: "240px",
				overflow: "auto",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				fontFamily: "var(--dsw-font-mono, ui-monospace, Consolas, monospace)",
				fontSize: "11px",
				lineHeight: "1.5",
				opacity: 0.85,
				borderLeft: "2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))",
				borderRadius: "4px",
				background: "var(--dsw-alias-bg-l1, rgba(127,127,127,.06))"
			},
			button: {
				flex: "0 0 auto",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: "18px",
				height: "18px",
				padding: 0,
				lineHeight: 1,
				color: "var(--dsw-alias-label-tertiary, inherit)",
				background: "transparent",
				border: "none",
				borderRadius: "3px",
				cursor: "pointer",
				opacity: 0.7
			},
			buttonDisabled: { opacity: 0.45, cursor: "default" }
		};

		// ── SVG icon: a U-turn / callback arrow (move to background) ───────────
		function BackgroundIcon() {
			return jsx("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx("polyline", { points: "9 10 4 15 9 20" }),
					jsx("path", { d: "M20 4v7a4 4 0 0 1-4 4H4" })
				]
			});
		}

		// ── the promote button ─────────────────────────────────────────────────
		/**
		 * One small SVG button after the latest command line. Clicking it asks the
		 * host half to resolve this call's foreground waiter; the call then returns
		 * immediately with a background job id while the process keeps running.
		 * Its click must not bubble up to the card's expand toggle.
		 */
		function PromoteButton(props) {
			var stateHook = react.useState("idle");
			var state = stateHook[0];
			var setState = stateHook[1];
			var onClick = function (event) {
				if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
					event.stopPropagation();
				}
				if (state === "busy" || state === "done") return;
				setState("busy");
				fetch("/manual-bg/promote", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ callId: props.callId })
				})
					.then((r) => r.json())
					.then((j) => setState(j !== null && typeof j === "object" && j.promoted === true ? "done" : "error"))
					.catch(() => setState("error"));
			};
			var done = state === "done";
			var busy = state === "busy";
			var title = state === "error" ? "转换失败，点击重试" : "把这条正在跑的命令切到后台（Ctrl+B 替代）";
			return jsxs("button", {
				type: "button",
				title: title,
				"aria-label": "转后台运行",
				onClick: onClick,
				disabled: busy || done,
				style: done || busy ? { ...S.button, ...S.buttonDisabled } : S.button,
				children: [jsx(BackgroundIcon, {})]
			});
		}

		// ── the custom tool view for wire tool `run` ───────────────────────────
		/**
		 * Collapsed single line by default (command + trailing ↪ button), like the
		 * native tool cards. Clicking the line expands an inline preview with the
		 * full command and the settled output; clicking again collapses it.
		 */
		function RunCard(props) {
			var block = props.block;
			var running = props.phase !== "result";
			var error = !running && block !== null && typeof block === "object" && block.isError === true;
			var command = readCommand(block);
			var output = running ? "" : readResultText(block);
			var openHook = react.useState(false);
			var open = openHook[0];
			var setOpen = openHook[1];
			var toggle = function () {
				setOpen(!open);
			};
			var onKeyDown = function (event) {
				if (event !== null && typeof event === "object" && (event.key === "Enter" || event.key === " ")) {
					if (typeof event.preventDefault === "function") event.preventDefault();
					toggle();
				}
			};
			var preview = command;
			if (output !== "") preview = command === "" ? output : command + "\n\n" + output;
			return jsxs("div", {
				style: S.root,
				children: [
					jsxs("div", {
						style: S.card,
						role: "button",
						tabIndex: 0,
						"aria-expanded": open,
						title: "点击展开 / 收起命令与输出",
						onClick: toggle,
						onKeyDown: onKeyDown,
						children: [
							jsx("code", {
								style: error ? { ...S.cmd, ...S.cmdError } : S.cmd,
								title: command,
								children: command === "" ? "run" : firstLine(command)
							}),
							running ? jsx(PromoteButton, { callId: props.callId }) : jsx("span", { style: S.spacer })
						]
					}),
					open && preview !== "" ? jsx("pre", { style: S.out, children: preview }) : null
				]
			});
		}

		// ── plugin ─────────────────────────────────────────────────────────────
		/** Client services this plugin needs. */
		var inject = ["slots"];

		/** Register the `run` Tool view, replacing the generic card for that wire name. */
		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject("tool.call.toolview", () =>
						ctx.slots.register(
							{
								name: "tool.call.toolview",
								key: "run"
							},
							RunCard
						)
					),
				"manual-bg: run toolview"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
