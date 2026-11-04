import { afterAll, describe, expect, test } from "bun:test";
import { anyAddress, fetchPage, isPrivateAddress, type AddressPolicy } from "./safeFetch";

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "2002:c0a8:0101::1",
    "fe80::1%eth0",
    "fd12:3456::1",
    "ff02::1",
    "not-an-address",
  ])("blocks %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  test.each(["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe("fetchPage", () => {
  const big = "x".repeat(10_000);
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const serve = (handler: (req: Request) => Response) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  };
  afterAll(async () => {
    await Promise.all(servers.map((server) => server.stop(true)));
  });

  const options = { userAgent: "test" };

  test("refuses file:// and other schemes", async () => {
    await expect(fetchPage("file:///C:/Windows/win.ini", options)).rejects.toThrow(
      "Only http and https",
    );
    await expect(fetchPage("data:text/plain,hi", options)).rejects.toThrow("Only http and https");
  });

  test("refuses localhost and private addresses by default", async () => {
    const base = serve(() => new Response("secret"));
    await expect(fetchPage(base, options)).rejects.toThrow("loopback, private or link-local");
    await expect(fetchPage("http://localhost:1/", options)).rejects.toThrow("loopback");
  });

  test("refuses a relative or malformed URL", async () => {
    await expect(fetchPage("/etc/passwd", options)).rejects.toThrow("Not an absolute URL");
  });

  test("follows redirects but checks every hop", async () => {
    const target = serve(() => new Response("landed"));
    const origin = serve(() => Response.redirect(`${target}/page`, 302));
    // Only the first server counts as public here.
    const onlyOrigin: AddressPolicy = (url) => url.origin === origin;
    await expect(fetchPage(origin, { ...options, allowed: onlyOrigin })).rejects.toThrow(
      "loopback, private or link-local",
    );
    const page = await fetchPage(origin, { ...options, allowed: anyAddress });
    expect(page.text).toBe("landed");
    expect(page.url).toBe(`${target}/page`);
  });

  test("refuses a redirect to file://", async () => {
    const origin = serve(
      () => new Response(null, { status: 302, headers: { Location: "file:///C:/Windows/win.ini" } }),
    );
    await expect(fetchPage(origin, { ...options, allowed: anyAddress })).rejects.toThrow(
      "Only http and https",
    );
  });

  test("stops after too many redirects", async () => {
    const loop = serve((req) => Response.redirect(req.url, 302));
    await expect(fetchPage(loop, { ...options, allowed: anyAddress })).rejects.toThrow(
      "Too many redirects",
    );
  });

  test("cuts the body at maxBytes", async () => {
    const base = serve(() => new Response(big));
    const page = await fetchPage(base, { ...options, allowed: anyAddress, maxBytes: 1000 });
    expect(page.text.length).toBe(1000);
    expect(page.truncated).toBe(true);
    const whole = await fetchPage(base, { ...options, allowed: anyAddress });
    expect(whole.text.length).toBe(big.length);
    expect(whole.truncated).toBe(false);
  });
});
