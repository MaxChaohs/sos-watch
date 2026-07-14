// geo.js — 用來源 IP 反查概略位置（免費、免 key、HTTPS）
// 服務：ipwho.is（免費約 1000 次/日）
// 注意：這是「城市級」定位，準確度取決於 ISP，可能差幾公里。
//
// 若你的專案是 ESM（package.json 有 "type":"module"）：
//   把下面的 module.exports 改成 export，require 改成 import 即可。
// fetch 是 Node 18+ 內建的全域函式，Railway 上可直接用。

// 從 Express req 取出真正的來源 IP
// （前提：app.set('trust proxy', true)，否則會拿到代理 IP）
function getClientIp(req) {
  let ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  // 去掉 IPv6 對 IPv4 的前綴，例如 ::ffff:1.2.3.4
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// 反查位置。永遠不丟例外——失敗回 null，不能因為定位失敗擋住求救。
async function lookupLocation(ip) {
  try {
    // 本機/私有 IP（本地測試時）：帶空字串讓服務改用「伺服器對外 IP」定位
    const isLocal =
      !ip || ip === '::1' ||
      ip.startsWith('127.') || ip.startsWith('10.') ||
      ip.startsWith('192.168.') || ip.startsWith('172.16.');
    const url = `https://ipwho.is/${isLocal ? '' : encodeURIComponent(ip)}`;

    // 4 秒 timeout，避免慢查詢拖住流程
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    const d = await res.json();
    if (!d || d.success === false) return null;

    return {
      lat: d.latitude,
      lng: d.longitude,
      city: d.city || null,
      region: d.region || null,
      country: d.country || null,
      // 給監控頁一個可點的地圖連結
      map_url: `https://www.google.com/maps?q=${d.latitude},${d.longitude}`,
      source: 'ip', // 標記：IP 級定位（粗略）
    };
  } catch (e) {
    console.error('geo lookup failed:', e.message);
    return null;
  }
}

module.exports = { getClientIp, lookupLocation };
