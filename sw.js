/* ============================================================================
   口腔工作台 · Service Worker
   ----------------------------------------------------------------------------
   目标：把工作台缓存到本机，断网也能打开、也能用。
   策略（按请求类型分流）：
     · 导航请求（HTML 页面）    → 网络优先，失败回落缓存
                                  （保证能拿到新版本；断网时用缓存打开）
     · 同源静态资源             → 缓存优先 + 后台静默更新
                                  （css/js/png/ico/json，快且离线可用）
     · CloudBase 接口           → 完全不拦截，直接放行
                                  （数据必须实时，缓存接口响应会造成脏数据）
     · 其它跨域请求             → 不拦截
   ----------------------------------------------------------------------------
   ⚠ 改版时请同步修改 CACHE_VERSION，否则用户可能一直用旧缓存。
   ========================================================================= */

const CACHE_VERSION = 'v3';
const CACHE_NAME = 'kq-workbench-' + CACHE_VERSION;

/* 需要预缓存的同源资源（相对路径，随站点部署位置自适应）。
   注意：本地没生成 icons/ 时，某个图标 404 不能让整体安装失败，
   所以下面用「逐个缓存、失败忽略」的方式，而不是 cache.addAll。 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './favicon.ico'
];

/* 绝对不缓存的域名（CloudBase 数据/鉴权接口） */
const NEVER_CACHE_HOSTS = [
  'tcloudbasegateway.com',   // PostgREST 数据接口 + Auth 接口
  'tencentcloudapi.com',     // 云 API
  'tcb-api.tencentcloudapi.com'
];

/* ---------------------------------------------------------------------------
   安装：预缓存核心文件
   --------------------------------------------------------------------------- */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    /* 逐个缓存：单个文件失败（如 404）不影响整体安装 */
    await Promise.all(PRECACHE.map(async url => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res);
      } catch (e) {
        /* 忽略单个资源的失败 */
      }
    }));
    /* 新版立即进入等待结束状态，不必等用户关掉所有标签页 */
    await self.skipWaiting();
  })());
});

/* ---------------------------------------------------------------------------
   激活：清理旧版本缓存 + 立即接管页面
   --------------------------------------------------------------------------- */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith('kq-workbench-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------------------------------------------------------------------------
   工具：判断是否该由 SW 接管
   --------------------------------------------------------------------------- */
function shouldNeverCache(url) {
  return NEVER_CACHE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
}

/* 同源静态资源后缀（决定用"缓存优先"还是"网络优先"） */
function isStaticAsset(url) {
  return /\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|json|webmanifest)$/i
    .test(url.pathname);
}

/* ---------------------------------------------------------------------------
   取数据
   --------------------------------------------------------------------------- */

/* 导航请求：网络优先，断网回落缓存 */
async function handleNavigate(request) {
  try {
    const fresh = await fetch(request);
    /* 顺手把最新的 index.html 存起来，供断网时使用 */
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put('./index.html', fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match('./index.html'))
        || (await cache.match('./'))
        || (await cache.match(request))
        || Response.error();
  }
}

/* 同源静态资源：缓存优先，同时后台更新 */
async function handleStatic(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const network = fetch(request).then(res => {
    /* 只缓存成功的同源响应 */
    if (res && res.ok && res.type === 'basic') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  /* 有缓存就先用缓存（快），网络结果留给下次 */
  if (cached) return cached;

  const res = await network;
  return res || Response.error();
}

/* ---------------------------------------------------------------------------
   主入口
   --------------------------------------------------------------------------- */
self.addEventListener('fetch', event => {
  const request = event.request;

  /* 只处理 GET */
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  /* 非 http(s)（如 data:、blob:）一律不管 */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* CloudBase 接口：绝不拦截，保证数据实时 */
  if (shouldNeverCache(url)) return;

  /* 只要同源资源；跨域其它请求交给浏览器默认行为 */
  if (url.origin !== self.location.origin) return;

  /* 导航请求（地址栏输入 / 点击链接 / 刷新） */
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  /* 同源静态资源 */
  if (isStaticAsset(url)) {
    event.respondWith(handleStatic(request));
    return;
  }

  /* 其余同源请求（比如查询参数接口）：网络优先，失败用缓存兜底 */
  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch (e) {
      const cached = await caches.match(request);
      return cached || Response.error();
    }
  })());
});

/* ---------------------------------------------------------------------------
   允许页面主动触发「立即更新」
   --------------------------------------------------------------------------- */
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  /* 页面请求清空缓存（调试/强制刷新用） */
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith('kq-workbench-')).map(k => caches.delete(k)));
      if (event.source && event.source.postMessage) {
        event.source.postMessage({ type: 'CACHE_CLEARED' });
      }
    })());
  }
});
