import { now } from "../domain/rules.mjs";
export function seedDemo(repo, ingestion, statistics) {
  if (repo.get("SELECT 1 FROM events LIMIT 1")) return;
  const names = [
    "SPIKE",
    "swordcat",
    "MOLLY",
    "HOTBOT",
    "SCAT",
    "AIKOL",
    "IBIT",
    "EPC",
    "A8",
    "MOON",
    "PI",
    "SUAN",
  ];
  const callers = ["Demo A", "Demo B", "Demo C", "Demo D", "Demo E", "Demo F"];
  for (let i = 0; i < names.length; i++) {
    const address = "0x" + (i + 1).toString(16).padStart(40, "0"),
      at = now() - 1800 - i * 120;
    ingestion.ingest({
      source: i % 2 ? "wechat" : "telegram",
      channel: i % 2 ? "demo@chatroom" : "tg:demo",
      message: "demo:" + i,
      revision: at * 1000,
      at,
      sender: callers[i % 6],
      senderId: String(i % 6),
      chain: i % 3 ? "bsc" : "base",
      addresses: [address],
      text: "合成演示消息",
    });
    const chain = i % 3 ? "bsc" : "base",
      c = repo.claim(chain, address);
    repo.run(
      "UPDATE tokens SET verified=1,metadata=? WHERE chain=? AND address=?",
      JSON.stringify({
        symbol: names[i],
        name: names[i],
        logo: "/brand.png",
        sources: { symbol: { provider: "demo", at: now() } },
      }),
      chain,
      address,
    );
    const mc = 15000 + i * 6000,
      price = mc / 1e9;
    statistics.write(chain, address, c.version, "baseline", {
      provider: "ave",
      mc,
      price,
      at,
      precision: "second",
      basis: "same-source-mcap-candle",
    });
    statistics.write(chain, address, c.version, "peak", {
      provider: "ave",
      mc: mc * (1.2 + i * 0.45),
      price: price * (1.2 + i * 0.45),
      at: at + 300,
      precision: "second",
      basis: "same-source-mcap-candle",
    });
    const factor = 0.8 + i * 0.23;
    repo.run(
      "INSERT INTO quotes VALUES(?,?,?,?,?,?)",
      chain,
      address,
      "dex",
      JSON.stringify({
        chain,
        mc: mc * factor,
        price: price * factor,
        source: "dex",
        mcBasis: "provider-reported",
      }),
      now(),
      1,
    );
  }
  repo.project();
}
