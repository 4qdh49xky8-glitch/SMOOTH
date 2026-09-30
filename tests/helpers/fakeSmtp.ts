import net from "node:net";

/** Faux serveur SMTP en boucle locale (127.0.0.1) : capture le message réellement émis par le transport et la ligne AUTH. */
export async function startFakeSmtp(): Promise<{ port: number; messages: { raw: string; auth?: string }[]; close: () => Promise<void> }> {
  const messages: { raw: string; auth?: string }[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => undefined);
    let data = "";
    let inData = false;
    let auth: string | undefined;
    let buf = "";
    sock.write("220 fake.local ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return void (data += buf), void (buf = "");
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push({ raw: data, auth });
          data = "";
          sock.write("250 OK\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const u = line.toUpperCase();
        if (u.startsWith("EHLO") || u.startsWith("HELO")) sock.write("250-fake.local\r\n250 AUTH PLAIN\r\n");
        else if (u.startsWith("AUTH")) ((auth = line), sock.write("235 OK\r\n"));
        else if (u.startsWith("DATA")) ((inData = true), sock.write("354 go\r\n"));
        else if (u.startsWith("QUIT")) (sock.write("221 bye\r\n"), sock.end());
        else sock.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    close: () => new Promise<void>((r) => ((sockets.forEach((s) => s.destroy()), server.close(() => r())))),
  };
}
