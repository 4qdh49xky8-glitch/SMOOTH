import { execFile } from "node:child_process";

export interface NotifyOptions {
  title: string;
  message: string;
  desktop?: boolean;
  sound?: boolean;
}

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): void => {
  // Arguments passés en tableau (pas de shell) : pas d'injection via le contenu du message.
  execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 5000 }, () => undefined).on("error", () => undefined);
};

/** Notification immédiate : bannière terminal + bip + notification OS + webhook optionnel. */
export async function notify({ title, message, desktop = true, sound = true }: NotifyOptions): Promise<void> {
  const line = "═".repeat(Math.max(title.length, 40) + 4);
  console.log(`\n${line}\n  ${title}\n  ${message.replace(/\n/g, "\n  ")}\n${line}\n${sound ? "\x07" : ""}`);

  if (desktop) {
    if (process.platform === "darwin") {
      run("osascript", [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title, message,
      ]);
      if (sound) run("afplay", ["/System/Library/Sounds/Glass.aiff"]);
    } else if (process.platform === "linux") {
      run("notify-send", ["--urgency=critical", title, message]);
    } else if (process.platform === "win32") {
      run(
        "powershell",
        ["-NoProfile", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms;$n=New-Object System.Windows.Forms.NotifyIcon;" +
          "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
          "$n.ShowBalloonTip(10000,$env:NOTIFY_TITLE,$env:NOTIFY_MESSAGE,'Info');Start-Sleep 10;$n.Dispose()"],
        { NOTIFY_TITLE: title, NOTIFY_MESSAGE: message },
      );
    }
  }

  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (url) {
    // Champs multiples pour rester compatible Slack (text), Discord (content) et génériques.
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, message, text: `${title}\n${message}`, content: `**${title}**\n${message}` }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => undefined);
  }
}
