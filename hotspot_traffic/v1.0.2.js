//<script>
(async () => {
    const REQUIRED_APIS = ['runShellWithRoot', 'createToast', 'createFixedToast', 'saveConfig', 'checkAdvancedFunc', 'collapseGen'];
    const missingApis = REQUIRED_APIS.filter((n) => {
        try { return typeof eval(n) !== 'function'; } catch { return true; }
    });
    if (missingApis.length) {
        const tip = 'UFI-TOOLS 版本过低，缺少 API: ' + missingApis.join(', ') + '，请升级到最新版本后再使用本插件';
        try { typeof createToast === 'function' ? createToast(tip, 'red', 6000) : alert(tip); } catch { try { alert(tip); } catch { } }
        return;
    }

    // ─── constants ────────────────────────────────────────────────────────────
    const _PREV_VER = '1.0.1';
    const NAME = 'hotspot_traffic';
    const MODAL = 'hotspot_traffic_panel';
    const STYLE = 'hotspot_traffic_style';
    const LS_KEY = 'hotspot_traffic_';
    const DATA_DIR = '/data/hotspot_traffic';
    const DATA_FILE = `${DATA_DIR}/data.json`;
    const STATION_FILE = `${DATA_DIR}/station_cache.txt`;
    const DIAG_RESULT_FILE = `${DATA_DIR}/diag_result.json`;
    const LAST_REPORT_TS_FILE = `${DATA_DIR}/_last_report_ts`;
    const JQ = '/data/data/com.minikano.f50_sms/files/jq';
    const DIAG_LOCK_FILE = `${DATA_DIR}/diag.lock`;
    const DEVICE_INFO_FILE = `${DATA_DIR}/device_info.txt`;
    const LOG_FILE = '/sdcard/hotspot_traffic_log.log';
    const SH_FILE = '/sdcard/hotspot_traffic.sh';
    const DIAG_SH_FILE = '/sdcard/hotspot_diag.sh';
    const DIAG_BIN_FILE = '/sdcard/hotspot_diag';
    const TRAFFIC_PROC = '/data/local/tmp/hotspot_traffic';
    const DIAG_PROC = '/data/local/tmp/hotspot_diag';
    const PID_FILE = `${DATA_DIR}/.pid`;
    const BOOT_SH_FILE = '/sdcard/ufi_tools_boot.sh';
    const BOOT_LINE = `cp /sdcard/hotspot_traffic ${TRAFFIC_PROC} && chmod 755 ${TRAFFIC_PROC} && nohup ${TRAFFIC_PROC} >/dev/null 2>&1 &`;
    const DINGTALK_WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=0cc8a901ee559f81eb26b2cb65dd148cc13e94d842a165fc231f7b86b9d012a8';
    const QQ_GROUP = '1019849819';
    const DIAG_COOLDOWN = 1000 * 60 * 5;
    const REPORT_COOLDOWN = 1000 * 60 * 15;
    const GH_VERSION_BASE = 'https://cdn.jsdelivr.net/gh/qybgh/UFI-TOOLS-assets@refs/heads/main/hotspot_traffic/';
    const _M = [0x4b,0x41,0x4e,0x4f,0x5f,0x50,0x4c,0x55,0x47,0x49,0x4e].map(c=>String.fromCharCode(c)).join('');
    const _PS = `<!-- [${_M}_START]`;
    const _PE = `<!-- [${_M}_END]`;
    const _SIG = '@@HT_PLUGIN_ID:7f3a9c@@';
    let _dataEvtBound = false;

    // ─── utils ────────────────────────────────────────────────────────────────
    const sq = (v) => `'${String(v ?? '').replace(/'/g, `'\''`)}'`;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const esc = (v) => String(v ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    const run = async (cmd, timeout = 30000) => runShellWithRoot(cmd, timeout);

    // ─── state ────────────────────────────────────────────────────────────────
    const state = {
        installed: false,
        dataCache: null,
        lastUpdated: '',
        summary: null,
        autoData: false,
        autoDataTimer: null,
        diagStatus: 'idle',
        diagResult: null,
        _installing: false,
        _uninstalling: false,
        _deviceVersion: '',
    };

    const collectDeviceInfo = async () => {
        try {
            const ufiData = await getUFIData();
            if (!ufiData) return null;
            const infoArr = [
                `model=${ufiData?.model || ''}`, `fw=${ufiData?.cr_version || ''}`,
                `app_ver=${ufiData?.app_ver || ''}`, `net_type=${ufiData?.network_type || ''}`,
                `carrier=${ufiData?.network_provider || ''}`, `ipv6=${ufiData?.ipv6_wan_ipaddr ? '1' : '0'}`,
            ];
            const hwR = await run(`echo "__USB__"; cat /sys/class/android_usb/android0/state 2>/dev/null; echo "__CPU__"; grep -m1 'Hardware' /proc/cpuinfo 2>/dev/null | awk -F: '{gsub(/^[ \\t]+/,"",\$2); print \$2}'; echo "__PLAT__"; getprop ro.board.platform 2>/dev/null; echo "__UP__"; awk '{printf "%d", \$1}' /proc/uptime`, 3000);
            const hwTxt = String(hwR?.content || '');
            const usbState = hwTxt.includes('__USB__') ? hwTxt.split('__USB__')[1].split('__CPU__')[0].trim() : '';
            const cpuModel = hwTxt.includes('__CPU__') ? hwTxt.split('__CPU__')[1].split('__PLAT__')[0].trim() : '';
            const platform = hwTxt.includes('__PLAT__') ? hwTxt.split('__PLAT__')[1].split('__UP__')[0].trim() : '';
            const uptime = hwTxt.includes('__UP__') ? hwTxt.split('__UP__')[1].trim() : '';
            if (usbState) infoArr.push(`usb=${usbState}`);
            if (cpuModel) infoArr.push(`cpu=${cpuModel}`);
            if (platform) infoArr.push(`platform=${platform}`);
            if (uptime) infoArr.push(`uptime=${uptime}s`);
            return infoArr.join('\n');
        } catch { return null; }
    };

    let _manifest = null;
    let _purged = false;
    const _initFallback = async () => {
        if (!_PREV_VER || _manifest) return;
        try {
            const _fbUrl = GH_VERSION_BASE + '_latest.json?_=' + Date.now();
            const _fbR = await run(`curl -sL --connect-timeout 8 --max-time 15 ${sq(_fbUrl)}`, 20000);
            const _fbT = String(_fbR?.content || '').trim();
            if (_fbT && _fbT[0] === '{') {
                const _fbJ = JSON.parse(_fbT);
                if (_fbJ.rev && _fbJ.guard && _fbJ.diag) {
                    _manifest = { version: _fbJ.rev, trafficUrl: _fbJ.guard, diagUrl: _fbJ.diag, jsUrl: _fbJ.js || '', notes: _fbJ.notes || '' };
                }
            }
        } catch {}
    };
    const fetchManifest = async (mode) => {
        if (!GH_VERSION_BASE) return;
        let url = null;
        let text = null;
        try {
            if (mode === 'init') {
                url = _PREV_VER
                    ? GH_VERSION_BASE + 'v' + _PREV_VER + '.json'
                    : GH_VERSION_BASE + '_latest.json?_=' + Date.now();
            } else {
                if (!state._deviceVersion) return;
                url = GH_VERSION_BASE + 'v' + state._deviceVersion + '.json';
            }
            const r = await run(`curl -sL --connect-timeout 8 --max-time 15 ${sq(url)}`, 20000);
            text = String(r?.content || '').trim();
            if (!text || text[0] !== '{') {
                if (mode === 'purge' && !_purged) {
                    _purged = true;
                    const purgeUrl = url.replace('cdn', 'purge');
                    run(`curl -sL --connect-timeout 8 --max-time 15 ${sq(purgeUrl)}`, 20000)
                        .then((pr) => console.log('[HT] purge url:', purgeUrl, 'resp:', String(pr?.content || '').trim()))
                        .catch((e) => console.warn('[HT] purge url:', purgeUrl, 'error:', e));
                }
                if (mode === 'init') await _initFallback();
                return;
            }
            const j = JSON.parse(text);
            if (!j.rev || !j.guard || !j.diag) {
                console.warn('[HT] fetch url:', url, 'incomplete manifest:', text);
                return;
            }
            _manifest = { version: j.rev, trafficUrl: j.guard, diagUrl: j.diag, jsUrl: j.js || '', notes: j.notes || '' };
            console.log('[HT] fetch url:', url, 'manifest:', JSON.stringify(_manifest));
        } catch (e) {
            console.warn('[HT] fetch url:', url, 'text:', text, 'error:', e);
            if (mode === 'init') await _initFallback();
        }
    };

    // ─── download + atomic deploy ─────────────────────────────
    const TRAFFIC_BIN_FILE = '/sdcard/hotspot_traffic';
    const TRAFFIC_NEW = TRAFFIC_BIN_FILE + '.new';
    const DIAG_NEW = DIAG_BIN_FILE + '.new';
    const PENDING_JS_FILE = '/data/local/tmp/_ht_pending.js';

    const downloadTrafficBin = async () => {
        try {
            if (!_manifest?.trafficUrl) return false;
            const tmpB64 = TRAFFIC_BIN_FILE + '.b64';
            await run(`curl -sL --fail --connect-timeout 10 --max-time 30 ${sq(_manifest.trafficUrl)} -o ${sq(tmpB64)}`, 35000);
            await run(`base64 -d ${sq(tmpB64)} > ${sq(TRAFFIC_NEW)} 2>/dev/null; rm -f ${sq(tmpB64)}`);
            const sz = await run(`wc -c < ${sq(TRAFFIC_NEW)} 2>/dev/null || echo 0`, 3000);
            if (parseInt(sz?.content || '0') < 100) { await run(`rm -f ${sq(TRAFFIC_NEW)}`); return false; }
            return true;
        } catch (e) { console.error('downloadTrafficBin:', e); return false; }
    };

    const downloadDiagBin = async () => {
        try {
            if (!_manifest?.diagUrl) return false;
            const tmpB64 = DIAG_BIN_FILE + '.b64';
            await run(`curl -sL --fail --connect-timeout 10 --max-time 30 ${sq(_manifest.diagUrl)} -o ${sq(tmpB64)}`, 35000);
            await run(`base64 -d ${sq(tmpB64)} > ${sq(DIAG_NEW)} 2>/dev/null; rm -f ${sq(tmpB64)}`);
            const sz = await run(`wc -c < ${sq(DIAG_NEW)} 2>/dev/null || echo 0`, 3000);
            if (parseInt(sz?.content || '0') < 100) { await run(`rm -f ${sq(DIAG_NEW)}`); return false; }
            return true;
        } catch (e) { console.error('downloadDiagBin:', e); return false; }
    };

    const preDownloadJs = async (jsUrl) => {
        const dlR = await run(`curl -sL --fail --connect-timeout 10 --max-time 30 ${sq(jsUrl)} -o ${sq(PENDING_JS_FILE)} && [ $(wc -c < ${sq(PENDING_JS_FILE)}) -gt 200 ] && echo OK || (rm -f ${sq(PENDING_JS_FILE)}; echo FAIL)`, 35000);
        if (!String(dlR?.content || '').includes('OK')) throw new Error('JS下载失败');
    };

    const atomicDeploy = async (ver) => {
        await run(`
mv ${sq(TRAFFIC_NEW)} ${sq(TRAFFIC_BIN_FILE)} && mv ${sq(DIAG_NEW)} ${sq(DIAG_BIN_FILE)} && chmod 755 ${sq(TRAFFIC_BIN_FILE)} ${sq(DIAG_BIN_FILE)} && printf '%s' ${sq('pending:' + ver)} > ${sq(DATA_DIR + '/.version.tmp')} && mv ${sq(DATA_DIR + '/.version.tmp')} ${sq(DATA_DIR + '/.version')}
`, 5000);
    };

    const applyPluginJs = async (prevVer) => {
        const chk = await run(`[ -s ${sq(PENDING_JS_FILE)} ] && echo EXISTS || echo NONE`, 2000);
        const hasNewJs = String(chk?.content || '').includes('EXISTS');
        if (!hasNewJs && !prevVer) return;
        let newJs;
        if (hasNewJs) {
            const r = await run(`base64 ${sq(PENDING_JS_FILE)} | tr -d '\n'`, 15000);
            const b64 = String(r?.content || '').trim();
            if (!b64 || b64.length < 200) { await run(`rm -f ${sq(PENDING_JS_FILE)}`); return; }
            try { newJs = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))); } catch { await run(`rm -f ${sq(PENDING_JS_FILE)}`); return; }
            if (!newJs || newJs.length < 200) { await run(`rm -f ${sq(PENDING_JS_FILE)}`); return; }
        }
        const currentText = await getCustomHead();
        if (!currentText) { if (hasNewJs) throw new Error('读取插件列表失败'); return; }
        const _esc = s => s.replace(/[\[\]]/g, '\\$&');
        const pluginRegex = new RegExp(_esc(_PS) + '\\s*(.*?)\\s*-->([\\s\\S]*?)' + _esc(_PE) + '\\s*\\1\\s*-->', 'g');
        let found = false, newText = currentText, match;
        while ((match = pluginRegex.exec(currentText)) !== null) {
            if (match[2].includes(_SIG)) {
                let content = hasNewJs ? newJs : match[2];
                if (prevVer) content = content.replace(/const _PREV_VER = '[^']*'/, `const _PREV_VER = '${prevVer}'`);
                if (!hasNewJs && content === match[2]) return;
                const pluginName = match[1].trim();
                const newBlock = `${_PS} ${pluginName} -->\n${content}\n${_PE} ${pluginName} -->`;
                newText = currentText.replace(match[0], () => newBlock);
                found = true;
                break;
            }
        }
        if (!found) { if (hasNewJs) throw new Error('未找到当前插件，请加群 ' + QQ_GROUP + ' 联系作者'); return; }
        const saveResult = await setCustomHead(newText);
        if (hasNewJs && (!saveResult || saveResult.result !== 'success')) throw new Error('保存失败');
        if (hasNewJs) await run(`rm -f ${sq(PENDING_JS_FILE)}`);
    };

    // ─── helpers ──────────────────────────────────────────────────────────────
    const probeIptables = async () => {
        const result = await run(`iptables -L FORWARD -n 2>/dev/null && echo __OK__ || echo __FAIL__`, 5000);
        return String(result?.content || '').includes('__OK__');
    };

    const getCustomName = (mac) => localStorage.getItem(LS_KEY + 'name_' + mac) || '';
    const setCustomName = (mac, name) => {
        if (name.trim()) localStorage.setItem(LS_KEY + 'name_' + mac, name.trim());
        else localStorage.removeItem(LS_KEY + 'name_' + mac);
    };
    const htFormatBytes = (bytes) => {
        const num = parseInt(bytes) || 0;
        const sign = num < 0 ? '-' : '';
        const abs = Math.abs(num);
        if (abs >= 1073741824) return sign + (abs / 1073741824).toFixed(2) + ' GB';
        if (abs >= 1048576) return sign + (abs / 1048576).toFixed(1) + ' MB';
        if (abs >= 1024) return sign + (abs / 1024).toFixed(0) + ' KB';
        return sign + abs + ' B';
    };

    const maskMac = (mac) => {
        if (!mac || typeof mac !== 'string') return mac || '';
        const parts = mac.split(':');
        if (parts.length !== 6) return mac;
        return `${parts[0]}:${parts[1]}:**:**:**:${parts[5]}`;
    };

    const sortDevices = (devicesMap) => Object.values(devicesMap || {}).sort((a, b) => {
        if (a.online && !b.online) return -1;
        if (!a.online && b.online) return 1;
        return ((b.rxBytes || 0) + (b.txBytes || 0)) - ((a.rxBytes || 0) + (a.txBytes || 0));
    });

    const calcSummaryMetrics = (summary, deviceList) => {
        const sysDelta = summary.sysDeltaBytes || 0;
        const iptTotal = summary.iptTotalBytes || 0;
        const iptV4 = summary.iptTotalV4Bytes || 0;
        const iptV6 = summary.iptTotalV6Bytes || 0;
        const onlineCount = deviceList.filter(d => d.online).length;
        const deviceCount = summary.deviceCount || 0;
        const deviceTotalBytes = summary.deviceTotalBytes || 0;
        const useTether = summary.useTether || false;
        const sysTxDelta = summary.sysDeltaTxBytes || 0;
        const sysRxDelta = summary.sysDeltaRxBytes || 0;
        const diffSigned = sysDelta - iptTotal;
        const diffAbs = Math.abs(diffSigned);
        const diffPct = sysDelta > 0 ? Math.round(diffAbs / sysDelta * 100) : 0;
        const unattrSigned = iptTotal - deviceTotalBytes;
        const unattrAbs = Math.abs(unattrSigned);
        const unattrPct = iptTotal > 0 ? Math.round(unattrAbs / iptTotal * 100) : 0;
        const diffCls = (diffSigned < 0) ? 'ht-status-alert' : (diffPct > 10 ? 'ht-status-warn' : 'ht-status-ok');
        const unattrCls = (unattrSigned < 0) ? 'ht-status-alert' : (unattrAbs <= 1048576) ? 'ht-status-ok' : (unattrPct > 30) ? 'ht-status-warn' : 'ht-status-ok';
        const deviceTxBytes = deviceList.reduce((s, d) => s + (d.txBytes || 0), 0);
        const deviceRxBytes = deviceList.reduce((s, d) => s + (d.rxBytes || 0), 0);
        return { sysDelta, iptTotal, iptV4, iptV6, onlineCount, deviceCount, deviceTotalBytes, useTether, sysTxDelta, sysRxDelta, diffSigned, unattrSigned, diffCls, unattrCls, deviceTxBytes, deviceRxBytes };
    };

    const resolveDisplayName = (device) => {
        const customName = getCustomName(device.mac);
        const hostname = (device.hostname || '').trim();
        return customName /* || hostname */ || '未知设备';
    };

    // ─── config read/write ────────────────────────────────────────────────────
    const readStatus = async () => {
        const result = await run(`
echo __BOOT__
timeout 2s awk '{print}' ${sq(BOOT_SH_FILE)} 2>/dev/null || true
echo __PROC__
_p=$(timeout 1s awk '{print}' ${sq(PID_FILE)} 2>/dev/null); [ -n "$_p" ] && kill -0 "$_p" 2>/dev/null && grep -q stb_ /proc/"$_p"/cmdline 2>/dev/null && echo running=1 || echo running=0
echo __DATA__
timeout 3s awk '{print}' ${sq(DATA_FILE)} 2>/dev/null || true
echo __VER__
timeout 2s awk '{print}' ${sq(DATA_DIR + '/.version')} 2>/dev/null || true
`);
        const text = String(result?.content || '');
        const bootPart = text.includes('__BOOT__') ? text.split('__BOOT__')[1].split('__PROC__')[0] : '';
        const procPart = text.includes('__PROC__') ? text.split('__PROC__')[1].split('__DATA__')[0] : '';
        const dataPart = text.includes('__DATA__') ? text.split('__DATA__')[1].split('__VER__')[0] : '';
        const verPart = text.includes('__VER__') ? text.split('__VER__')[1].trim() : '';
        state._deviceVersion = verPart || '';
        state.installed = bootPart.includes(NAME) && procPart.includes('running=1');
        if (dataPart.trim()) {
            try {
                const parsed = JSON.parse(dataPart.trim());
                if (parsed && parsed.devices && typeof parsed.devices === 'object') {
                    state.dataCache = parsed;
                    state.lastUpdated = parsed.updatedAt || '';
                    state.summary = parsed.summary || null;
                }
            } catch { }
        }
    };

    const recoverPendingUpdate = async () => {
        const dv = state._deviceVersion || '';
        if (!dv.startsWith('pending:')) return;
        const ver = dv.replace('pending:', '');
        let jsApplied = false;
        try { await applyPluginJs(_PREV_VER); jsApplied = true; } catch (e) { console.warn('[HT] recovery JS apply:', e); }
        await run(`rm -f ${sq(DIAG_RESULT_FILE)} ${sq(DATA_DIR + '/diag_state.txt')} ${sq(LAST_REPORT_TS_FILE)} ${sq(DIAG_LOCK_FILE)} 2>/dev/null`);
        clearDiagState();
        await run(`printf '%s' ${sq(ver)} > ${sq(DATA_DIR + '/.version.tmp')} && mv ${sq(DATA_DIR + '/.version.tmp')} ${sq(DATA_DIR + '/.version')}`);
        state._deviceVersion = ver;
        if (jsApplied) {
            createToast('插件已恢复更新，2秒后刷新页面', 'green');
            setTimeout(() => location.reload(), 2000);
        }
    };

    // ─── install / uninstall ──────────────────────────────────────────────────
    const IPT_CLEANUP = `iptables -t mangle -D FORWARD -j HT_IF_TX 2>/dev/null
iptables -t mangle -F HT_IF_TX 2>/dev/null
iptables -t mangle -X HT_IF_TX 2>/dev/null
iptables -t mangle -D FORWARD -j HT_IF_RX 2>/dev/null
iptables -t mangle -F HT_IF_RX 2>/dev/null
iptables -t mangle -X HT_IF_RX 2>/dev/null
ip6tables -t mangle -D FORWARD -j HT_IF6_TX 2>/dev/null
ip6tables -t mangle -F HT_IF6_TX 2>/dev/null
ip6tables -t mangle -X HT_IF6_TX 2>/dev/null
ip6tables -t mangle -D FORWARD -j HT_IF6_RX 2>/dev/null
ip6tables -t mangle -F HT_IF6_RX 2>/dev/null
ip6tables -t mangle -X HT_IF6_RX 2>/dev/null
iptables -t mangle -D FORWARD -j HT_DEV_TX 2>/dev/null
iptables -t mangle -F HT_DEV_TX 2>/dev/null
iptables -t mangle -X HT_DEV_TX 2>/dev/null
iptables -t mangle -D FORWARD -j HT_DEV_RX 2>/dev/null
iptables -t mangle -F HT_DEV_RX 2>/dev/null
iptables -t mangle -X HT_DEV_RX 2>/dev/null
ip6tables -t mangle -D FORWARD -j HT_DEV6_TX 2>/dev/null
ip6tables -t mangle -F HT_DEV6_TX 2>/dev/null
ip6tables -t mangle -X HT_DEV6_TX 2>/dev/null
ip6tables -t mangle -D FORWARD -j HT_DEV6_RX 2>/dev/null
ip6tables -t mangle -F HT_DEV6_RX 2>/dev/null
ip6tables -t mangle -X HT_DEV6_RX 2>/dev/null`;

    const cleanResidue = async () => {
        try {
            await run(`
_p=$(awk '{print}' ${sq(PID_FILE)} 2>/dev/null); [ -n "$_p" ] && kill "$_p" 2>/dev/null; pkill -f ${sq(SH_FILE)} 2>/dev/null; sleep 1; [ -n "$_p" ] && kill -9 "$_p" 2>/dev/null; pkill -9 -f ${sq(SH_FILE)} 2>/dev/null
sed -i '/${NAME}/d' ${sq(BOOT_SH_FILE)} 2>/dev/null
${IPT_CLEANUP}
rm -f ${sq(TRAFFIC_BIN_FILE)} ${sq(DIAG_BIN_FILE)} ${sq(SH_FILE)} ${sq(DIAG_SH_FILE)} ${sq(LOG_FILE)} ${TRAFFIC_PROC} ${DIAG_PROC}
rm -rf ${sq(DATA_DIR)}
mkdir -p ${sq(DATA_DIR)}
`, 10000);
        } catch (e) { console.error('cleanResidue:', e); }
    };

    const install = async () => {
        if (state._installing) return createToast('正在启用中，请稍候', 'yellow');
        if (!(await checkAdvancedFunc())) return createToast('没有开启高级功能，无法使用！', 'red');
        state._installing = true;
        const { close: closeLoading } = createFixedToast('ht_installing', '初始化中...');
        try {
            await fetchManifest('init');
            if (!_manifest) return createToast('无法获取版本信息，请检查网络', 'red');
            await cleanResidue();
            if (!(await probeIptables())) return createToast('当前不支持 iptables，无法安装，请重启设备后再试', 'red');
            await run(`mkdir -p ${sq(DATA_DIR)}`);
            const ver = _manifest?.version || '';
            if (!(await downloadTrafficBin())) return createToast('上传脚本文件失败！', 'red');
            if (!(await downloadDiagBin())) return createToast('上传诊断脚本失败！', 'red');
            if (_manifest.jsUrl) await preDownloadJs(_manifest.jsUrl);
            try {
                const infoLines = await collectDeviceInfo();
                if (infoLines) await run(`printf '%s' ${sq(infoLines)} > ${sq(DEVICE_INFO_FILE)}; echo`);
            } catch {}
            await atomicDeploy(ver);
            await run(`grep -qxF ${sq(BOOT_LINE)} ${sq(BOOT_SH_FILE)} || echo ${sq(BOOT_LINE)} >> ${sq(BOOT_SH_FILE)}`);
            await run(`
_p=$(awk '{print}' ${sq(PID_FILE)} 2>/dev/null); [ -n "$_p" ] && kill "$_p" 2>/dev/null; pkill -f ${sq(SH_FILE)} 2>/dev/null; sleep 1; [ -n "$_p" ] && kill -9 "$_p" 2>/dev/null; pkill -9 -f ${sq(SH_FILE)} 2>/dev/null; rm -f ${sq(PID_FILE)}
cp ${sq(TRAFFIC_BIN_FILE)} ${TRAFFIC_PROC} && chmod 755 ${TRAFFIC_PROC} && nohup ${TRAFFIC_PROC} >/dev/null 2>&1 &
`);
            await applyPluginJs(_PREV_VER);
            if (ver) await run(`printf '%s' ${sq(ver)} > ${sq(DATA_DIR + '/.version.tmp')} && mv ${sq(DATA_DIR + '/.version.tmp')} ${sq(DATA_DIR + '/.version')}`);
            state.installed = true;
            state._deviceVersion = ver;
            if (_manifest?.jsUrl) {
                createToast('已启用并更新到最新版 v' + ver + '，2秒后刷新页面', 'green');
                setTimeout(() => location.reload(), 2000);
                return;
            }
            createToast('热点流量监控已启用并设为自启动', 'green');
        } catch (e) {
            createToast('启用失败：' + (e && e.message ? e.message : String(e)), 'red');
        } finally { state._installing = false; closeLoading(); }
    };

    const uninstall = async () => {
        if (state._uninstalling) return createToast('正在卸载中，请稍候', 'yellow');
        if (!(await checkAdvancedFunc())) return createToast('没有开启高级功能，无法使用！', 'red');
        state._uninstalling = true;
        setAutoData(false);
        _dataEvtBound = false;
        try {
            await run(`
sed -i '/${NAME}/d' ${sq(BOOT_SH_FILE)} 2>/dev/null
_p=$(awk '{print}' ${sq(PID_FILE)} 2>/dev/null); [ -n "$_p" ] && kill "$_p" 2>/dev/null; pkill -f ${sq(SH_FILE)} 2>/dev/null; sleep 1; [ -n "$_p" ] && kill -9 "$_p" 2>/dev/null; pkill -9 -f ${sq(SH_FILE)} 2>/dev/null
${IPT_CLEANUP}
rm -f ${sq(TRAFFIC_BIN_FILE)} ${sq(DIAG_BIN_FILE)} ${sq(SH_FILE)} ${sq(DIAG_SH_FILE)} ${sq(LOG_FILE)} ${TRAFFIC_PROC} ${DIAG_PROC}
rm -rf ${sq(DATA_DIR)}
`, 10000);
            state.installed = false; state.dataCache = null; state.lastUpdated = ''; state.summary = null;
            clearDiagState();
            createToast('热点流量监控已停用');
        } catch (e) {
            createToast('停用失败：' + (e && e.message ? e.message : String(e)), 'red');
        }
        state._uninstalling = false;
    };

    // ─── data ─────────────────────────────────────────────────────────────────
    const loadData = async () => {
        try {
            const result = await run(`echo __DATA__; [ -f ${sq(DATA_FILE)} ] && timeout 3s awk '{print}' ${sq(DATA_FILE)} 2>/dev/null; echo __STATION__; [ -f ${sq(STATION_FILE)} ] && awk 'NF' ${sq(STATION_FILE)} 2>/dev/null || true`, 5000);
            const raw = String(result?.content ?? '');
            const dataIdx = raw.indexOf('__DATA__');
            const stIdx = raw.indexOf('__STATION__');
            if (dataIdx < 0 || stIdx < 0) return;

            const dataText = raw.slice(dataIdx + 8, stIdx).trim();
            const stText = raw.slice(stIdx + 11).trim();

            if (dataText) {
                const parsed = JSON.parse(dataText);
                if (!parsed || typeof parsed.devices !== 'object' || !parsed.summary) {
                    console.warn('[HT] data.json 结构不完整，跳过本轮');
                    return;
                }
                state.dataCache = parsed;
                state.lastUpdated = parsed.updatedAt || '';
                state.summary = parsed.summary || null;
            }

            if (stText && state.dataCache) {
                const onlineMacs = new Set();
                stText.split('\n').forEach(line => {
                    const parts = line.split('|');
                    const ip = (parts[0] || '').trim();
                    const mac = (parts[1] || '').trim();
                    if (!mac) return;
                    onlineMacs.add(mac);
                    if (!state.dataCache.devices[mac]) {
                        const hostname = (parts[2] || '').trim();
                        state.dataCache.devices[mac] = { mac, ip, hostname, online: true, txBytes: 0, rxBytes: 0 };
                    } else {
                        const dev = state.dataCache.devices[mac];
                        dev.online = true;
                        if (ip) dev.ip = ip;
                        const hn = (parts[2] || '').trim();
                        if (hn && !dev.hostname) dev.hostname = hn;
                    }
                    if (state.dataCache.devices[mac]) state.dataCache.devices[mac]._missCount = 0;
                });
                Object.values(state.dataCache.devices).forEach(dev => {
                    if (!onlineMacs.has(dev.mac)) {
                        dev._missCount = (dev._missCount || 0) + 1;
                        if (dev._missCount >= 2) dev.online = false;
                    }
                });
            }
        } catch (e) { console.warn('[HT] loadData:', e); }
    };

    let dataLoading = false;
    const refreshDataArea = async () => {
        const area = document.querySelector(`#${MODAL} #ht_data_area`);
        if (!area) return;
        if (area.querySelector('[data-ht]')) {
            await patchDataArea();
            return;
        }
        if (dataLoading) return;
        dataLoading = true;
        try {
            await loadData();
            area.innerHTML = renderDataArea();
            initDataDelegate();
        } finally { dataLoading = false; }
    };

    const patchDataArea = async () => {
        if (dataLoading) return;
        dataLoading = true;
        try {
            await loadData();
            const el = document.querySelector(`#${MODAL} #ht_data_area`);
            if (!el || !state.dataCache) return;

            const devicesMap = state.dataCache.devices || {};
            const deviceList = sortDevices(devicesMap);
            const summary = state.summary;

            if (summary) {
                const m = calcSummaryMetrics(summary, deviceList);

                const si0 = el.querySelector('[data-ht="si_0"]');
                const si1 = el.querySelector('[data-ht="si_1"]');
                const si2 = el.querySelector('[data-ht="si_2"]');
                const si3 = el.querySelector('[data-ht="si_3"]');
                if (si0) si0.innerHTML = `<div class="ht-summary-val">${esc(htFormatBytes(m.sysDelta))}${(m.sysTxDelta || m.sysRxDelta) ? renderUlDl(m.sysTxDelta, m.sysRxDelta) : ''}</div><div class="ht-summary-lbl">系统增量</div>`;
                if (si1) si1.innerHTML = `<div class="ht-summary-val">${esc(htFormatBytes(m.iptTotal))}</div><div class="ht-summary-lbl">热点合计${m.useTether ? '' : ` <span style="font-size:.48rem;opacity:.6">v4:${esc(htFormatBytes(m.iptV4))} v6:${esc(htFormatBytes(m.iptV6))}</span>`}</div><div style="font-size:.46rem;opacity:.45;margin-top:1px;line-height:1.3">偏差:<span class="${m.diffCls}">${esc(htFormatBytes(m.diffSigned))}</span></div>`;
                if (si2) si2.innerHTML = `<div class="ht-summary-val">在线 <span class="${m.onlineCount > 0 ? 'ht-status-ok' : 'ht-muted'}">${m.onlineCount}</span> / 总 ${m.deviceCount}</div><div class="ht-summary-lbl">接入设备</div>`;
                if (si3) si3.innerHTML = `<div class="ht-summary-val">${esc(htFormatBytes(m.deviceTotalBytes))}${renderUlDl(m.deviceTxBytes, m.deviceRxBytes)}</div><div class="ht-summary-lbl">设备合计</div><div style="font-size:.46rem;opacity:.45;margin-top:1px;line-height:1.3">未归属:<span class="${m.unattrCls}">${esc(htFormatBytes(m.unattrSigned))}</span></div>`;
            }

            const tbody = el.querySelector('tbody');
            if (!tbody) {
                if (deviceList.length > 0) { el.innerHTML = renderDataArea(); initDataDelegate(); }
                return;
            }

            const domMacs = [];
            tbody.querySelectorAll('tr[data-mac]').forEach(tr => domMacs.push(tr.dataset.mac));
            const newMacs = deviceList.map(d => d.mac);
            const orderChanged = domMacs.length !== newMacs.length || domMacs.some((m, i) => m !== newMacs[i]);

            if (orderChanged) {
                tbody.innerHTML = deviceList.map((d, i) => renderDeviceRow(d, i)).join('');
            } else {
                deviceList.forEach((device, index) => {
                    const tr = tbody.querySelector(`tr[data-mac="${esc(device.mac)}"]`);
                    if (!tr) return;
                    const displayName = resolveDisplayName(device);
                    const txBytes = device.txBytes || 0;
                    const rxBytes = device.rxBytes || 0;
                    const totalBytes = txBytes + rxBytes;
                    const p = (attr, val) => { const n = tr.querySelector(`[data-ht="${attr}"]`); if (n && n.textContent !== val) n.textContent = val; };
                    p('idx', String(index + 1));
                    p('name', displayName);
                    p('ip', device.ip || '');
                    p('tx', htFormatBytes(txBytes));
                    p('rx', htFormatBytes(rxBytes));
                    p('total', 'Σ ' + htFormatBytes(totalBytes));
                    const dot = tr.querySelector('[data-ht="dot"]');
                    if (dot) { const cls = device.online ? 'ht-dot ht-dot-green' : 'ht-dot ht-dot-gray'; if (dot.className !== cls) dot.className = cls; }
                });
            }

            const updatedShort = state.lastUpdated ? state.lastUpdated.slice(11, 19) : '';
            const dateEl = el.querySelector('[data-ht="sum_date"]');
            if (dateEl) { const txt = updatedShort ? `（更新时间 ${updatedShort}）` : ''; if (dateEl.textContent !== txt) dateEl.textContent = txt; }

        } finally { dataLoading = false; }
    };

    // ─── log popup ────────────────────────────────────────────────────────────
    const copyToClipboard = async (text) => {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text); return true;
            }
        } catch {}
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch { return false; }
    };

    const showLogPopup = async () => {
        const fetchLog = async () => {
            const r = await run(`[ -f ${sq(LOG_FILE)} ] && timeout 2s tail -80 ${sq(LOG_FILE)} || echo "(暂无日志)"`, 5000);
            return String(r?.content ?? '').trim();
        };
        const logText = await fetchLog();
        const { el: toastEl, close } = createFixedToast('ht_log_toast', `<div style="pointer-events:all;width:90vw;max-width:420px"><div class="title" style="margin:0 0 6px;display:flex;align-items:center;justify-content:space-between">运行日志<span id="ht_log_qq" title="点击复制群号" style="font-size:.64rem;font-weight:700;cursor:pointer;margin-left:auto;color:#bae6fd;background:rgba(56,189,248,.16);border:1px solid rgba(56,189,248,.42);border-radius:7px;padding:2px 9px;line-height:1.35;white-space:nowrap;letter-spacing:.3px;">反馈群:${QQ_GROUP}</span></div><textarea id="ht_log_area" readonly style="width:100%;height:40vh;font-size:.56rem;line-height:1.5;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:6px;color:inherit;resize:none;"></textarea><div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px"><button id="ht_log_refresh" style="font-size:.6rem">刷新</button><button id="ht_log_copy" style="font-size:.6rem">复制</button><button id="ht_log_close" style="font-size:.6rem">关闭</button></div></div>`);
        const area = toastEl.querySelector('#ht_log_area');
        area.value = logText; area.scrollTop = area.scrollHeight;
        toastEl.querySelector('#ht_log_qq').onclick = async () => { await copyToClipboard(QQ_GROUP); createToast('群号已复制', 'green'); };
        toastEl.querySelector('#ht_log_refresh').onclick = async () => { area.value = await fetchLog(); area.scrollTop = area.scrollHeight; };
        toastEl.querySelector('#ht_log_copy').onclick = async () => { await copyToClipboard(area.value); createToast('日志已复制', 'green'); };
        toastEl.querySelector('#ht_log_close').onclick = () => close();
    };

    const stopAutoData = () => { if (state.autoDataTimer) clearInterval(state.autoDataTimer); state.autoDataTimer = null; };
    const setAutoData = (enabled) => {
        state.autoData = Boolean(enabled && state.installed);
        stopAutoData();
        if (state.autoData) {
            state.autoDataTimer = setInterval(() => {
                if (document.querySelector('#collapse_ht')?.dataset?.name !== 'open' || !state.installed || !state.autoData) { setAutoData(false); return; }
                refreshDataArea();
            }, 5000);
        }
    };

    // ─── style ────────────────────────────────────────────────────────────────
    const ensureStyle = () => {
        if (document.getElementById(STYLE)) return;
        const s = document.createElement('style');
        s.id = STYLE;
        s.textContent = `
      #${MODAL} .ht-wrap{display:flex;flex-direction:column;gap:2px;font-size:.72rem;}
      #${MODAL} .ht-card{border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border-radius:12px;padding:8px 10px;}
      #${MODAL} .ht-wrap>.ht-card:first-child{padding-top:6px;padding-bottom:6px;}
      #${MODAL} #ht_data_area{display:flex;flex-direction:column;gap:2px;}
      #${MODAL} .ht-row{display:flex;align-items:center;gap:5px;}
      #${MODAL} .ht-btn{border-radius:7px;padding:5px 10px;font-size:.64rem;cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:inherit;transition:background .15s,opacity .15s;}
      #${MODAL} .ht-btn:hover{background:rgba(255,255,255,.14);}
      #${MODAL} .ht-btn:disabled{opacity:.35;cursor:not-allowed;}
      #${MODAL} .ht-btn-success{background:rgba(34,197,94,.22);border-color:rgba(34,197,94,.35);color:#86efac;}
      #${MODAL} .ht-btn-stop{background:rgba(249,115,22,.22);border-color:rgba(249,115,22,.35);color:#fdba74;}
      #${MODAL} .ht-btn-ghost{background:transparent;border-color:rgba(255,255,255,.12);opacity:.8;}
      #${MODAL} .ht-btn-ghost:hover{opacity:1;background:rgba(255,255,255,.06);}
      #${MODAL} .ht-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:3px;vertical-align:middle;}
      #${MODAL} .ht-dot-green{background:#4ade80;box-shadow:0 0 4px rgba(74,222,128,.5);}
      #${MODAL} .ht-dot-gray{background:rgba(255,255,255,.25);}
      #${MODAL} .ht-tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
      #${MODAL} .ht-tbl{width:100%;border-collapse:collapse;font-size:.62rem;}
      #${MODAL} .ht-tbl th{font-size:.54rem;opacity:.45;font-weight:500;text-align:left;padding:3px 4px;border-bottom:1px solid rgba(255,255,255,.08);white-space:nowrap;}
      #${MODAL} .ht-tbl td{padding:4px 4px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;}
      #${MODAL} .ht-tbl tr:last-child td{border-bottom:none;}
      #${MODAL} .ht-tbl .ht-td-name{font-weight:600;display:flex;align-items:center;gap:3px;line-height:1.2;}
      #${MODAL} .ht-tbl .ht-td-meta{font-size:.52rem;opacity:.4;line-height:1.3;word-break:break-all;margin-top:1px;}
      #${MODAL} .ht-tbl .ht-td-num{font-weight:600;white-space:nowrap;font-size:.6rem;}
      #${MODAL} .ht-mac{cursor:pointer;border-bottom:1px dashed rgba(255,255,255,.2);}
      #${MODAL} .ht-mac:hover{opacity:.85;}
      #${MODAL} .ht-edit-mini{background:none;border:none;cursor:pointer;opacity:.4;font-size:.58rem;padding:0 1px;color:inherit;line-height:1;flex-shrink:0;}
      #${MODAL} .ht-edit-mini:hover{opacity:1;}
      #${MODAL} .ht-up{color:#67e8f9;}
      #${MODAL} .ht-down{color:#86efac;}
      #${MODAL} .ht-total{color:rgba(255,255,255,.7);}
      #${MODAL} .ht-summary-val .ht-up,#${MODAL} .ht-summary-val .ht-down{color:inherit;}
      #${MODAL} .ht-muted{color:rgba(255,255,255,.35);}
      #${MODAL} .ht-status-ok{color:#86efac;}
      #${MODAL} .ht-status-warn{color:#fdba74;}
      #${MODAL} .ht-status-alert{color:#fca5a5;}
      #${MODAL} .ht-empty{padding:10px;border:1px dashed rgba(255,255,255,.12);border-radius:9px;opacity:.55;text-align:center;font-size:.6rem;}
      #${MODAL} .ht-updated{font-size:.52rem;opacity:.35;margin-left:auto;}
      #${MODAL} .ht-date{font-size:.56rem;opacity:.5;margin-left:6px;color:#93c5fd;}
      #${MODAL} .ht-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;}
      #${MODAL} .ht-summary-item{background:rgba(0,0,0,.12);border-radius:8px;padding:6px 8px;}
      #${MODAL} .ht-summary-val{font-size:.76rem;font-weight:700;margin-bottom:1px;line-height:1.15;}
      #${MODAL} .ht-summary-lbl{font-size:.52rem;opacity:.45;line-height:1.25;}
      #${MODAL} .ht-diag-item{padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.58rem;line-height:1.35;word-break:break-all;}
      @media(max-width:380px){#${MODAL} .ht-wrap{font-size:.66rem;gap:2px;} #${MODAL} .ht-card{padding:7px 9px;} #${MODAL} .ht-summary-grid{grid-template-columns:repeat(2,1fr);} #${MODAL} .ht-summary-val{font-size:.7rem;} #${MODAL} .ht-tbl{font-size:.58rem;} #${MODAL} .ht-btn{padding:4px 8px;font-size:.6rem;}}
    `;
        document.head.appendChild(s);
    };

    // ─── render ───────────────────────────────────────────────────────────────
    const renderDeviceRow = (device, index) => {
        const displayName = resolveDisplayName(device);
        const defaultName = (device.hostname || '').trim() || '未知设备';
        const txBytes = device.txBytes || 0;
        const rxBytes = device.rxBytes || 0;
        const totalBytes = txBytes + rxBytes;
        const safeMac = esc(device.mac || '');
        const online = device.online;
        const dotCls = online ? 'ht-dot-green' : 'ht-dot-gray';
        return `<tr data-mac="${safeMac}">
        <td style="opacity:.4;font-size:.54rem;width:18px;text-align:center;" data-ht="idx">${index + 1}</td>
        <td>
          <div class="ht-td-name">
            <span class="ht-dot ${dotCls}" data-ht="dot"></span>
            <span data-ht="name">${esc(displayName)}</span>
            <button class="ht-edit-mini" data-edit-mac="${safeMac}" data-edit-default="${esc(defaultName)}" title="自定义名称">✎</button>
          </div>
          <div class="ht-td-meta"><span data-ht="ip">${esc(device.ip || '')}</span> · <span class="ht-mac" data-full-mac="${safeMac}" data-masked="1" title="点击查看完整 MAC">${esc(maskMac(device.mac || ''))}</span></div>
        </td>
        <td class="ht-td-num"><span class="ht-up" data-ht="tx">${esc(htFormatBytes(txBytes))}</span></td>
        <td class="ht-td-num"><span class="ht-down" data-ht="rx">${esc(htFormatBytes(rxBytes))}</span></td>
        <td class="ht-td-num ht-total" data-ht="total">Σ ${esc(htFormatBytes(totalBytes))}</td>
      </tr>`;
    };

    const renderUlDl = (tx, rx) => ` <span style="font-size:.48rem;opacity:.7"><span class="ht-up">↑${esc(htFormatBytes(tx))}</span> <span class="ht-down">↓${esc(htFormatBytes(rx))}</span></span>`;

    const renderDataArea = () => {
        const installed = state.installed;
        const devicesMap = (state.dataCache && state.dataCache.devices) ? state.dataCache.devices : {};
        const deviceList = sortDevices(devicesMap);
        const summary = state.summary;
        const dataDate = (state.dataCache && state.dataCache.date) || new Date().toISOString().slice(0, 10);

        let summaryHtml;
        if (summary) {
            const m = calcSummaryMetrics(summary, deviceList);
            const zeroWarn = (summary.zeroStreak >= 3 && installed) ? `<div class="ht-status-alert" style="font-size:.55rem;margin-top:4px;">热点合计持续为0，可能受硬件加速影响，建议点击「诊断」排查</div>` : '';
            summaryHtml = `<div class="ht-summary-grid">
            <div class="ht-summary-item" data-ht="si_0"><div class="ht-summary-val">${esc(htFormatBytes(m.sysDelta))}${(m.sysTxDelta || m.sysRxDelta) ? renderUlDl(m.sysTxDelta, m.sysRxDelta) : ''}</div><div class="ht-summary-lbl">系统增量</div></div>
            <div class="ht-summary-item" data-ht="si_1"><div class="ht-summary-val">${esc(htFormatBytes(m.iptTotal))}</div><div class="ht-summary-lbl">热点合计${m.useTether ? '' : ` <span style="font-size:.48rem;opacity:.6">v4:${esc(htFormatBytes(m.iptV4))} v6:${esc(htFormatBytes(m.iptV6))}</span>`}</div><div style="font-size:.46rem;opacity:.45;margin-top:1px;line-height:1.3">偏差:<span class="${m.diffCls}">${esc(htFormatBytes(m.diffSigned))}</span></div></div>
            <div class="ht-summary-item" data-ht="si_2"><div class="ht-summary-val">在线 <span class="${m.onlineCount > 0 ? 'ht-status-ok' : 'ht-muted'}">${m.onlineCount}</span> / 总 ${m.deviceCount}</div><div class="ht-summary-lbl">接入设备</div></div>
            <div class="ht-summary-item" data-ht="si_3"><div class="ht-summary-val">${esc(htFormatBytes(m.deviceTotalBytes))}${renderUlDl(m.deviceTxBytes, m.deviceRxBytes)}</div><div class="ht-summary-lbl">设备合计</div><div style="font-size:.46rem;opacity:.45;margin-top:1px;line-height:1.3">未归属:<span class="${m.unattrCls}">${esc(htFormatBytes(m.unattrSigned))}</span></div></div>
          </div>${zeroWarn}`;
        } else {
            summaryHtml = `<div class="ht-empty" style="font-size:.58rem;">启用并等待首次采集后显示</div>`;
        }

        const devicesHtml = deviceList.length > 0
            ? `<div class="ht-tbl-wrap"><table class="ht-tbl">
                <thead><tr><th style="width:18px;text-align:center;">#</th><th>设备</th><th>↑上传</th><th>↓下载</th><th>合计</th></tr></thead>
                <tbody>${deviceList.map((d, i) => renderDeviceRow(d, i)).join('')}</tbody>
               </table></div>`
            : `<div class="ht-empty">${installed ? '已启用，等待首次采集到接入设备...' : '启用后开始统计各接入设备的流量'}</div>`;

        const updatedShort = state.lastUpdated ? state.lastUpdated.slice(11, 19) : '';

        return `
        <div class="ht-card">
          <div class="ht-row" style="justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;">
            <div class="ht-row"><b>流量概览</b><span class="ht-date">${esc(dataDate)}<span data-ht="sum_date">${installed && updatedShort ? `（更新时间 ${esc(updatedShort)}）` : ''}</span></span></div>
            <button id="ht_devices_toggle" class="ht-btn ht-btn-ghost" style="font-size:.56rem;padding:2px 8px;">${localStorage.getItem('hotspot_traffic_devices_collapsed') === '1' ? '设备明细 ▼' : '设备明细 ▲'}</button>
          </div>
          ${summaryHtml}
        </div>
        <div class="ht-card" id="ht_devices_card" style="${localStorage.getItem('hotspot_traffic_devices_collapsed') === '1' ? 'display:none' : ''}">
          ${devicesHtml}
        </div>`;
    };

    const render = () => {
        const installed = state.installed;
        const dotCls = installed ? 'ht-dot-green' : 'ht-dot-gray';
        const statusText = installed ? '运行中' : '未启用';
        const toggleCls = installed ? 'ht-btn-stop' : 'ht-btn-success';
        const toggleTxt = installed ? `<span class="ht-dot ht-dot-green"></span>停用` : '启用';
        const diagBtnText = state.diagStatus === 'done' ? '诊断结果' : state.diagStatus === 'running' ? '诊断中...' : '诊断';
        const _remoteVer = _manifest?.version || '';
        const _devVer = state._deviceVersion;
        const _verDisplay = state.installed ? (_devVer || '') : _remoteVer;
        const _hasUpdate = _remoteVer && _devVer && _remoteVer !== _devVer;
        const _updateBtnHtml = _hasUpdate ? '<span id="ht-update-btn" style="font-size:.5rem;color:#4ade80;cursor:pointer;margin-left:3px;-webkit-user-select:none;user-select:none;">更新 v' + esc(_remoteVer) + '</span>' : '';
        const _verHtml = _verDisplay ? `<span id="ht-ver-tap" style="font-size:.5rem;opacity:.35;margin-left:4px;cursor:pointer;-webkit-user-select:none;user-select:none;">v${esc(_verDisplay)}</span>${_updateBtnHtml}` : '';

        return `<div class="ht-wrap">
        <div class="ht-card">
          <div class="ht-row" style="justify-content:space-between;">
            <div class="ht-row"><span class="ht-dot ${dotCls}"></span><span style="font-size:.68rem;">${esc(statusText)}</span>${_verHtml}</div>
            <div class="ht-row">
              <button class="ht-btn ht-btn-ghost" data-act="log" ${installed ? '' : 'disabled'}>日志</button>
              <button class="ht-btn ht-btn-ghost" data-act="diag" ${installed ? '' : 'disabled'}>${diagBtnText}</button>
              <button class="ht-btn ${toggleCls}" data-act="toggle">${toggleTxt}</button>
            </div>
          </div>
        </div>
        <div id="ht_data_area">${renderDataArea()}</div>
      </div>`;
    };

    // ─── diag ─────────────────────────────────────────────────────────────────
    const clearDiagState = () => {
        state.diagStatus = 'idle';
        state.diagResult = null;
    };

    const updateDiagBtn = () => {
        const btn = document.querySelector(`#${MODAL} [data-act="diag"]`);
        if (!btn) return;
        btn.textContent = state.diagStatus === 'done' ? '诊断结果' : state.diagStatus === 'running' ? '诊断中...' : '诊断';
    };

    const startDiag = async () => {
        if (!state.installed) return createToast('请先启用插件', 'pink');
        if (state.diagStatus === 'running') return;
        state.diagStatus = 'running';
        updateDiagBtn();
        const _resetDiag = () => { state.diagStatus = 'idle'; updateDiagBtn(); };
        try { await readStatus(); } catch (e) { state.summary = null; console.warn('[HT] readStatus in diag:', e); }
        if (state.summary && state.summary.scriptStartAt) {
            const startMs = new Date(state.summary.scriptStartAt).getTime();
            if (!Number.isFinite(startMs)) { _resetDiag(); return createToast('插件数据尚未就绪，请等待采集完成后再诊断', 'pink'); }
            const elapsed = Date.now() - startMs;
            if (elapsed < DIAG_COOLDOWN) {
                const sec = Math.floor(elapsed / 1000);
                const t = sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60 ? sec % 60 + '秒' : ''}` : `${sec}秒`;
                _resetDiag();
                return createToast(`插件当前启动${t}，请等待至少5分钟后再诊断`, 'pink');
            }
        } else {
            _resetDiag();
            return createToast('插件数据尚未就绪，请等待采集完成后再诊断', 'pink');
        }
        const now = new Date();
        if (now.getHours() === 0 && now.getMinutes() === 0) { _resetDiag(); return createToast('跨日数据重建中，请1分钟后再诊断', 'pink'); }
        const probe = await run(`[ -f ${sq(DIAG_BIN_FILE)} ] && echo __READY__ || echo __MISS__`, 5000);
        if (!String(probe?.content || '').includes('__READY__')) {
            _resetDiag();
            return createToast('诊断脚本未就绪，请停用后重新启用插件', 'pink');
        }
        const aliveChk = await run(`if [ -f ${sq(DIAG_LOCK_FILE)} ]; then _age=$(( $(date +%s) - $(stat -c %Y ${sq(DIAG_LOCK_FILE)} 2>/dev/null || echo 0) )); if [ "$_age" -gt 60 ]; then rm -f ${sq(DIAG_LOCK_FILE)}; echo __STALE__; else pid=$(awk '{print}' ${sq(DIAG_LOCK_FILE)} 2>/dev/null); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo __ALIVE__ || { rm -f ${sq(DIAG_LOCK_FILE)}; echo __DEAD__; }; fi; else echo __DEAD__; fi`, 5000);
        const chkResult = String(aliveChk?.content || '');
        if (chkResult.includes('__ALIVE__')) {
            _resetDiag();
            return createToast('诊断正在进行中，请等待完成', 'pink');
        }
        if (chkResult.includes('__STALE__')) {
            createToast('检测到残留锁文件已清理，正在重新诊断...', 'green', 2000);
        }
        const verChk = await run(`timeout 2s awk '{print}' ${sq(DATA_DIR + '/.version')} 2>/dev/null`, 5000);
        const installedVer = String(verChk?.content || '').trim();
        const currentVer = state._deviceVersion || '';
        if (installedVer && currentVer && installedVer !== currentVer) {
            _resetDiag();
            return createToast(`插件已更新(${currentVer})，请重新启用插件以生效`, 'pink', 5000);
        }
        const { close: closeLoading } = createFixedToast('ht_diag_loading', '诊断中...');
        try {
            const infoLines = await collectDeviceInfo();
            if (infoLines) await run(`printf '%s' ${sq(infoLines)} > ${sq(DEVICE_INFO_FILE)}; echo`);
        } catch {}
        await run(`rm -f ${sq(DIAG_RESULT_FILE)} ${sq(DIAG_SH_FILE)} 2>/dev/null
cp ${sq(DIAG_BIN_FILE)} ${DIAG_PROC} && chmod 755 ${DIAG_PROC} && nohup ${DIAG_PROC} >/dev/null 2>&1 &`, 5000);
        closeLoading();
        createToast('诊断已启动，后台执行中...', 'green', 2000);
        const _diagPoll = setInterval(async () => {
            try {
                const dr = await run(`[ -s ${sq(DIAG_RESULT_FILE)} ] && echo __DONE__ || echo __WAIT__`, 3000);
                if (String(dr?.content || '').includes('__DONE__')) {
                    clearInterval(_diagPoll);
                    const dtxt = await run(`timeout 3s awk '{print}' ${sq(DIAG_RESULT_FILE)} 2>/dev/null`, 5000);
                    const dc = String(dtxt?.content || '').trim();
                    if (dc) {
                        try {
                            state.diagResult = JSON.parse(dc);
                            state.diagStatus = 'done';
                            updateDiagBtn();
                            createToast('诊断完成', 'green', 2000);
                        } catch {}
                    }
                }
            } catch {}
        }, 3000);
        setTimeout(() => {
            clearInterval(_diagPoll);
            if (state.diagStatus === 'running') {
                state.diagStatus = 'idle';
                updateDiagBtn();
                createToast('诊断超时或失败，请稍后重试', 'pink');
            }
        }, 35000);
    };

    let _lastReportTime = 0;

    const showDiagResult = () => {
        if (!state.diagResult) return createToast('暂无诊断结果', 'pink');
        const j = state.diagResult;
        const hasIssue = Array.isArray(j.checks) && j.checks.some(c => !c.startsWith('\u2713'));
        const reportStatus = j.auto_reported ? '<span style="color:#4ade80">\u2714 \u5df2\u4e0a\u62a5</span>'
            : !hasIssue ? '<span style="opacity:.4">\u65e0\u5f02\u5e38\uff0c\u65e0\u9700\u4e0a\u62a5</span>'
            : '<span style="color:#93c5fd">\u2191 \u5efa\u8bae\u4e0a\u62a5</span>';
        let html = '';

        if (Array.isArray(j.checks)) {
            html += `<div style="margin-bottom:6px;display:flex;align-items:baseline;justify-content:space-between"><b>检查项</b><span style="font-size:.5rem">${reportStatus}</span></div>`;
            j.checks.forEach(c => {
                const idx1 = c.indexOf(':');
                const idx2 = c.indexOf(':', idx1 + 1);
                const sym = c.substring(0, idx1);
                const id = c.substring(idx1 + 1, idx2);
                const detail = c.substring(idx2 + 1);
                const color = sym === '\u2713' ? '#86efac' : sym === '!' ? '#fdba74' : '#fca5a5';
                html += `<div class="ht-diag-item"><span style="color:${color};margin-right:2px">${sym}</span><span style="font-weight:600">${esc(id)}</span><span style="opacity:.4">: </span><span style="opacity:.55">${esc(detail)}</span></div>`;
            });
        }

        const text = JSON.stringify(j);
        const diagVer = j.version || state._deviceVersion || '';
        const { el: toastEl, close } = createFixedToast('ht_diag_result_toast', `<div style="pointer-events:all;width:92vw;max-width:420px;max-height:75vh;display:flex;flex-direction:column"><div class="title" style="margin:0 0 6px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between">诊断结果<span style="font-size:.5rem;opacity:.35;margin-left:6px;font-weight:400">v${esc(diagVer)}</span><span id="ht_diag_qq" title="点击复制群号" style="font-size:.64rem;font-weight:700;cursor:pointer;margin-left:auto;color:#bae6fd;background:rgba(56,189,248,.16);border:1px solid rgba(56,189,248,.42);border-radius:7px;padding:2px 9px;line-height:1.35;white-space:nowrap;letter-spacing:.3px;">反馈群:${QQ_GROUP}</span></div>${(_manifest && _manifest.version && _manifest.version !== state._deviceVersion) ? '<div id="ht-diag-upd-banner" style="display:flex;align-items:center;justify-content:space-between;border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.12);color:#86efac;border-radius:8px;padding:8px 10px;margin:0 0 6px;cursor:pointer;font-size:.55rem"><span>发现新版本 v' + esc(_manifest.version) + '，点此查看</span><span style="opacity:.7">›</span></div>' : ''}<div style="flex:1;overflow:auto;min-height:0">${html}</div><div style="display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);flex-shrink:0"><button id="ht_diag_copy" class="ht-btn ht-btn-success" style="font-size:.62rem">复制报告</button><button id="ht_diag_report" class="ht-btn ht-btn-ghost" style="font-size:.62rem">上报</button><button id="ht_diag_redo" class="ht-btn ht-btn-ghost" style="font-size:.62rem">重新诊断</button><button id="ht_diag_close" class="ht-btn ht-btn-ghost" style="font-size:.62rem">关闭</button></div></div>`);
        toastEl.querySelector('#ht_diag_close').onclick = () => close();
        const _updBanner = toastEl.querySelector('#ht-diag-upd-banner');
        if (_updBanner) { _updBanner.onclick = () => { close(); setTimeout(() => performUpdateFlow(), 200); }; }
        toastEl.querySelector('#ht_diag_copy').onclick = async () => {
            await copyToClipboard(text);
            createToast('已复制', 'green');
        };
        toastEl.querySelector('#ht_diag_report').onclick = async () => {
            if (!hasIssue) {
                createToast('诊断结果无异常，如有问题请加群反馈', 'pink', 3000);
                await copyToClipboard(QQ_GROUP);
                return;
            }
            const markReported = async () => {
                _lastReportTime = Date.now();
                j.auto_reported = true;
                const _sec = Math.floor(_lastReportTime / 1000);
                await run(`printf '%s' ${sq(_sec)} > ${sq(LAST_REPORT_TS_FILE)}
_m=$(${sq(JQ)} '.auto_reported=true' ${sq(DIAG_RESULT_FILE)} 2>/dev/null); [ -n "$_m" ] && printf '%s' "$_m" > ${sq(DIAG_RESULT_FILE + '.tmp')} && mv ${sq(DIAG_RESULT_FILE + '.tmp')} ${sq(DIAG_RESULT_FILE)}
echo`, 5000);
            };
            const _st = await run(`_ts=$(awk '{print $1+0}' ${sq(LAST_REPORT_TS_FILE)} 2>/dev/null); _ar=$(awk '/auto_reported/{c=1} END{print c+0}' ${sq(DIAG_RESULT_FILE)} 2>/dev/null); echo "ts=$_ts ar=$_ar"`, 3000);
            const _out = String(_st?.content || '');
            const _tsm = _out.match(/ts=(\d+)/);
            const _fts = _tsm ? parseInt(_tsm[1]) : 0;
            if (_fts) _lastReportTime = Math.max(_lastReportTime, _fts * 1000);
            const autoReported = j.auto_reported || _out.includes('ar=1');
            if (autoReported) {
                return createToast('当前诊断已上报，请加群跟进或重新诊断', 'green', 3000);
            }
            if (_lastReportTime && Date.now() - _lastReportTime < REPORT_COOLDOWN) {
                return createToast('上报间隔未达15分钟，请稍后重新诊断后再上报', 'pink');
            }
            try {
                const body = JSON.stringify({msgtype: 'text', text: {content: text}});
                const tmpFile = `${DATA_DIR}/_report.tmp`;
                const r = await run(`printf '%s' ${sq(body)} > ${sq(tmpFile)} && _r=$(timeout 10s curl -s -X POST -H 'Content-Type: application/json;charset=UTF-8' -d @${sq(tmpFile)} ${sq(DINGTALK_WEBHOOK)} 2>/dev/null) && rm -f ${sq(tmpFile)} && echo "$_r" || { rm -f ${sq(tmpFile)}; echo '{"errcode":-1}'; }`, 15000);
                const output = String(r?.content || '').trim();
                if (output.includes('"errcode":0') || output.includes('"errcode": 0')) {
                    await markReported();
                    createToast('上报成功，可加群跟进', 'green');
                } else if (output.includes('310000')) {
                    createToast('当前插件版本过旧，请更新到最新版本后重试', 'red', 5000);
                } else {
                    createToast('上报失败，请加群反馈', 'red');
                }
                await copyToClipboard(QQ_GROUP);
            } catch {
                createToast('上报失败，请加群反馈', 'red');
                await copyToClipboard(QQ_GROUP);
            }
        };
        toastEl.querySelector('#ht_diag_qq').onclick = async () => {
            await copyToClipboard(QQ_GROUP);
            createToast('群号已复制', 'green');
        };
        toastEl.querySelector('#ht_diag_redo').onclick = async () => { close(); await startDiag(); };
    };

    const restoreDiagState = async () => {
        const r = await run(`echo __TS__
awk '{print $1+0}' ${sq(LAST_REPORT_TS_FILE)} 2>/dev/null
echo __RESULT__
[ -s ${sq(DIAG_RESULT_FILE)} ] && timeout 3s awk '{print}' ${sq(DIAG_RESULT_FILE)} 2>/dev/null || echo`, 5000);
        const text = String(r?.content || '');
        const _tsStr = text.includes('__TS__') ? text.split('__TS__')[1].split('__RESULT__')[0].trim() : '';
        const _fts = parseInt(_tsStr) || 0;
        if (_fts) _lastReportTime = Math.max(_lastReportTime, _fts * 1000);
        const resultStr = text.includes('__RESULT__') ? text.split('__RESULT__')[1].trim() : '';
        if (resultStr) {
            try {
                state.diagResult = JSON.parse(resultStr);
                state.diagStatus = 'done';
            } catch { state.diagStatus = 'idle'; state.diagResult = null; }
        } else {
            state.diagStatus = 'idle';
            state.diagResult = null;
        }
    };

    // ─── bind ─────────────────────────────────────────────────────────────────
    const initDataDelegate = () => {
        if (_dataEvtBound) return;
        const area = document.querySelector(`#${MODAL} #ht_data_area`);
        if (!area) return;
        _dataEvtBound = true;
        area.addEventListener('click', (e) => {
            const toggleBtn = e.target.closest('#ht_devices_toggle');
            if (toggleBtn) {
                e.stopPropagation();
                const card = document.querySelector(`#${MODAL} #ht_devices_card`);
                if (!card) return;
                const isCollapsed = card.style.display === 'none';
                card.style.display = isCollapsed ? '' : 'none';
                toggleBtn.textContent = isCollapsed ? '设备明细 ▲' : '设备明细 ▼';
                localStorage.setItem('hotspot_traffic_devices_collapsed', isCollapsed ? '0' : '1');
                return;
            }
            const macSpan = e.target.closest('[data-full-mac]');
            if (macSpan) {
                e.stopPropagation();
                const full = macSpan.dataset.fullMac || '';
                const masked = macSpan.dataset.masked === '1';
                if (masked) { macSpan.textContent = full; macSpan.dataset.masked = '0'; macSpan.title = '点击隐藏部分 MAC'; }
                else { macSpan.textContent = maskMac(full); macSpan.dataset.masked = '1'; macSpan.title = '点击查看完整 MAC'; }
                return;
            }
            const editBtn = e.target.closest('[data-edit-mac]');
            if (editBtn) {
                e.stopPropagation();
                const mac = editBtn.dataset.editMac;
                const defaultName = editBtn.dataset.editDefault;
                const currentName = getCustomName(mac);
                const { el: toastEl, close } = createFixedToast('ht_edit_name_toast', `<div style="pointer-events:all;width:80vw;max-width:280px"><div class="title" style="margin:0 0 8px">自定义设备名称</div><div style="font-size:.58rem;opacity:.45;margin-bottom:6px">${esc(mac)}</div><input id="ht_name_input" type="text" value="${esc(currentName)}" placeholder="${esc(defaultName)}" style="width:100%;box-sizing:border-box;padding:5px 8px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:inherit;font-size:.68rem;outline:none;margin-bottom:6px;"><div style="display:flex;gap:6px;justify-content:flex-end"><button id="ht_name_clear" style="font-size:.62rem;opacity:.6">清除</button><button id="ht_name_save" style="font-size:.62rem">保存</button></div></div>`);
                const input = toastEl.querySelector('#ht_name_input');
                input.focus(); input.select();
                toastEl.querySelector('#ht_name_save').onclick = () => { setCustomName(mac, input.value); patchDataArea(); close(); };
                toastEl.querySelector('#ht_name_clear').onclick = () => { setCustomName(mac, ''); patchDataArea(); close(); };
                input.onkeydown = (ev) => { if (ev.key === 'Enter') toastEl.querySelector('#ht_name_save').click(); if (ev.key === 'Escape') close(); };
            }
        });
    };

    const renderIntoPanel = () => {
        const box = document.querySelector(`#${MODAL} .collapse_box`);
        if (!box) return;
        _dataEvtBound = false;
        box.innerHTML = render();
        bind(document.querySelector(`#${MODAL}`));
    };

    let _stopClickCount = 0;
    let _stopClickTimer = null;

    let _verTapCount = 0, _verTapTimer = null, _updating = false;

    const performUpdate = async () => {
        if (!_manifest) {
            await fetchManifest('update');
            if (!_manifest) throw new Error('无法获取版本信息');
        }
        const oldVer = state._deviceVersion || '';
        const ver = _manifest?.version || '';
        await run(`rm -f ${sq(TRAFFIC_NEW)} ${sq(DIAG_NEW)} ${sq(PENDING_JS_FILE)} ${sq(TRAFFIC_BIN_FILE + '.b64')} ${sq(DIAG_BIN_FILE + '.b64')} 2>/dev/null`);
        if (!(await downloadTrafficBin())) throw new Error('主脚本获取失败');
        if (!(await downloadDiagBin())) throw new Error('诊断脚本获取失败');
        if (_manifest.jsUrl) await preDownloadJs(_manifest.jsUrl);
        await atomicDeploy(ver);
        await run(`
_p=$(awk '{print}' ${sq(PID_FILE)} 2>/dev/null); [ -n "$_p" ] && kill "$_p" 2>/dev/null; pkill -f ${sq(SH_FILE)} 2>/dev/null; sleep 1; [ -n "$_p" ] && kill -9 "$_p" 2>/dev/null; pkill -9 -f ${sq(SH_FILE)} 2>/dev/null; rm -f ${sq(PID_FILE)}
cp ${sq(TRAFFIC_BIN_FILE)} ${TRAFFIC_PROC} && chmod 755 ${TRAFFIC_PROC} && nohup ${TRAFFIC_PROC} >/dev/null 2>&1 &
`);
        await applyPluginJs(oldVer);
        await run(`rm -f ${sq(DIAG_RESULT_FILE)} ${sq(DATA_DIR + '/diag_state.txt')} ${sq(LAST_REPORT_TS_FILE)} ${sq(DIAG_LOCK_FILE)} 2>/dev/null`);
        clearDiagState();
        if (ver) await run(`printf '%s' ${sq(ver)} > ${sq(DATA_DIR + '/.version.tmp')} && mv ${sq(DATA_DIR + '/.version.tmp')} ${sq(DATA_DIR + '/.version')}`);
        state._deviceVersion = ver;
    };

    const showUpdateConfirm = (newVer, notes) => {
        return new Promise((resolve) => {
            const notesHtml = (notes && notes.trim()) ? esc(notes.trim()) : '（本次更新暂无说明）';
            const { el, close } = createFixedToast('ht_update_confirm', `<div style="pointer-events:all;width:88vw;max-width:400px"><div class="title" style="margin:0 0 8px">热点流量监控 · 发现新版本 v${esc(newVer)}</div><div style="font-size:.58rem;line-height:1.6;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:8px 10px;max-height:40vh;overflow-y:auto;white-space:pre-wrap;word-break:break-word;">${notesHtml}</div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px"><button id="ht_upd_cancel" style="font-size:.62rem;padding:5px 14px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:inherit;cursor:pointer;">取消</button><button id="ht_upd_ok" style="font-size:.62rem;padding:5px 14px;border-radius:7px;border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.25);color:#86efac;cursor:pointer;">确认更新</button></div></div>`);
            let done = false;
            const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
            el.querySelector('#ht_upd_cancel').onclick = () => finish(false);
            el.querySelector('#ht_upd_ok').onclick = () => finish(true);
        });
    };

    const performUpdateFlow = async () => {
        if (_updating) return createToast('正在更新中，请稍候', 'yellow');
        if (!(await checkAdvancedFunc())) return;
        if (!_manifest) {
            const { close: closeChecking } = createFixedToast('ht_update_checking', '正在检查更新...');
            try { await fetchManifest('purge'); }
            finally { closeChecking(); }
        }
        if (!_manifest) {
            return createToast('当前已是最新版本 v' + state._deviceVersion, 'green');
        }
        const confirmed = await showUpdateConfirm(_manifest.version, _manifest.notes);
        if (!confirmed) return;
        _updating = true;
        const { close } = createFixedToast('ht_update_loading', '正在更新...');
        try {
            await performUpdate();
            createToast('已更新到 v' + state._deviceVersion + '，2秒后刷新页面', 'green');
            setTimeout(() => location.reload(), 2000);
        } catch (e) {
            createToast('更新失败：' + (e?.message || String(e)), 'red');
        } finally {
            _updating = false;
            close();
        }
    };

    const handleUpdateClick = async () => {
        if (!state.installed) return;
        if (_updating) return createToast('正在更新中，请稍候', 'yellow');
        clearTimeout(_verTapTimer);
        _verTapCount++;
        _verTapTimer = setTimeout(() => { _verTapCount = 0; }, 3000);
        if (_verTapCount < 3) return;
        _verTapCount = 0;
        clearTimeout(_verTapTimer);
        await performUpdateFlow();
    };

    const bind = (el) => {
        if (!el) return;
        const toggleBtn = el.querySelector('[data-act="toggle"]');
        if (toggleBtn) toggleBtn.onclick = async (e) => {
            const btn = e.currentTarget;
            if (btn.disabled) return;
            if (state.installed) {
                _stopClickCount++;
                if (_stopClickTimer) clearTimeout(_stopClickTimer);
                _stopClickTimer = setTimeout(() => { _stopClickCount = 0; }, 2000);
                if (_stopClickCount < 3) {
                    createToast(`再点击${3 - _stopClickCount}次停用`, 'pink', 1500);
                    return;
                }
                _stopClickCount = 0;
            }
            btn.disabled = true;
            try {
                if (state.installed) { await uninstall(); renderIntoPanel(); }
                else {
                    const probeR = await run(`_p=$(timeout 1s awk '{print}' ${sq(PID_FILE)} 2>/dev/null); [ -n "$_p" ] && kill -0 "$_p" 2>/dev/null && grep -q stb_ /proc/"$_p"/cmdline 2>/dev/null && echo __ALIVE__ || echo __DEAD__`, 5000);
                    if (String(probeR?.content || '').includes('__ALIVE__')) {
                        await readStatus();
                        if (state.installed) await loadData();
                        renderIntoPanel();
                        if (state.installed) setAutoData(true);
                        createToast('插件已在后台运行，已刷新状态', 'green');
                    } else {
                        await install();
                        if (state.installed) await loadData();
                        renderIntoPanel();
                        if (state.installed) setAutoData(true);
                    }
                }
            } catch (err) {
                createToast('操作异常：' + (err && err.message ? err.message : String(err)), 'red');
            } finally { btn.disabled = false; }
        };
        const logBtn = el.querySelector('[data-act="log"]');
        if (logBtn) logBtn.onclick = (e) => { e.stopPropagation(); showLogPopup(); };
        const diagBtn = el.querySelector('[data-act="diag"]');
        if (diagBtn) diagBtn.onclick = async (e) => {
            e.stopPropagation();
            if (state.diagStatus === 'done') { showDiagResult(); return; }
            if (state.diagStatus === 'idle') { await startDiag(); return; }
        };
        initDataDelegate();

        const verEl = el.querySelector('#ht-ver-tap');
        if (verEl) {
            verEl.onclick = () => { handleUpdateClick(); };
        }
        const updateBtn = el.querySelector('#ht-update-btn');
        if (updateBtn) {
            updateBtn.onclick = (e) => { e.stopPropagation(); handleUpdateClick(); };
        }
    };

    // ─── help ─────────────────────────────────────────────────────────────────
    const HELP_TEXT = `<b>功能</b><br>统计热点接入设备的流量，每天 0 点自动重置。<br><br><b>流量概览</b><br>系统增量 = 插件启用后或今日开始的系统总流量；热点合计 = 热点转发的流量；偏差 = 两者之差，主UFI本机进程流量和可能的硬件加速偏差。<br><br><b>设备明细</b><br>按设备展示上传/下载流量。未归属 = 热点合计与设备合计的差值，通常占比较小。<br><br><b>诊断</b><br>检测常见问题，可一键上报诊断结果给作者分析。`;

    const showHelp = () => {
        const { el: toastEl, close } = createFixedToast('ht_help_toast', `
            <div style="pointer-events:all;width:80vw;max-width:300px">
                <div class="title" style="margin:0;display:flex;align-items:center;justify-content:space-between">使用说明<span id="ht_help_qq" title="点击复制群号" style="font-size:.64rem;font-weight:700;cursor:pointer;margin-left:auto;color:#bae6fd;background:rgba(56,189,248,.16);border:1px solid rgba(56,189,248,.42);border-radius:7px;padding:2px 9px;line-height:1.35;white-space:nowrap;letter-spacing:.3px;">反馈群:${QQ_GROUP}</span></div>
                <div style="margin:10px 0;font-size:.64rem;line-height:1.6">${HELP_TEXT}</div>
                <div style="text-align:right"><button style="font-size:.62rem" id="ht_help_dismiss">关闭</button></div>
            </div>`);
        toastEl.querySelector('#ht_help_qq').onclick = async () => { await copyToClipboard(QQ_GROUP); createToast('群号已复制', 'green'); };
        toastEl.querySelector('#ht_help_dismiss').onclick = () => close();
    };

    const injectHelpButton = (container) => {
        const titleEl = container.querySelector('.title strong');
        if (!titleEl) return;
        const helpBtn = document.createElement('button');
        helpBtn.textContent = '?';
        helpBtn.style.cssText = 'width:16px;height:16px;border-radius:50%;padding:0;font-size:.5rem;line-height:16px;text-align:center;cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:rgba(255,255,255,.7);margin-left:8px;vertical-align:middle;flex-shrink:0;';
        helpBtn.onclick = (e) => { e.stopPropagation(); showHelp(); };
        titleEl.insertAdjacentElement('afterend', helpBtn);
    };

    // ─── mount ────────────────────────────────────────────────────────────────
    ensureStyle();
    const getPluginRoot = () => {
        let root = document.getElementById('kano_plugin_panels');
        if (!root) {
            root = document.createElement('div');
            root.id = 'kano_plugin_panels';
            root.style.width = '100%';
            const devMon = document.querySelector('.devices-mon');
            if (!devMon) return null;
            devMon.insertAdjacentElement('beforebegin', root);
        }
        return root;
    };
    const pluginRoot = getPluginRoot();
    if (!pluginRoot) return;
    pluginRoot.insertAdjacentHTML('beforeend', `
        <div id="${MODAL}" style="width:100%;margin-top:10px;">
            <div class="title" style="margin:6px 0;">
                <strong>热点流量监控</strong>
                <div style="display:inline-block;" id="collapse_ht_btn"></div>
            </div>
            <div class="collapse" id="collapse_ht" data-name="close" style="height:0;overflow:hidden;">
                <div class="collapse_box"></div>
            </div>
        </div>
    `);

    const panelEl = document.querySelector(`#${MODAL}`);
    injectHelpButton(panelEl);

    collapseGen('#collapse_ht_btn', '#collapse_ht', '#collapse_ht', async (newVal) => {
        if (newVal === 'open') {
            await readStatus();
            await recoverPendingUpdate();
            await restoreDiagState();
            if (state.installed) await loadData();
            renderIntoPanel();
            setAutoData(state.installed);
            fetchManifest().then(() => renderIntoPanel());
        } else {
            setAutoData(false);
        }
    });

    if (localStorage.getItem('#collapse_ht') === 'open') {
        (async () => {
            await readStatus();
            if (!state.installed) {
                const bootChk = await run(`grep -q ${sq(NAME)} ${sq(BOOT_SH_FILE)} 2>/dev/null && echo 1 || echo 0`, 3000);
                if (String(bootChk?.content || '').includes('1')) {
                    await wait(800);
                    await readStatus();
                }
            }
            await recoverPendingUpdate();
            await restoreDiagState();
            if (state.installed) await loadData();
            renderIntoPanel();
            setAutoData(state.installed);
            fetchManifest().then(() => renderIntoPanel());
        })();
    }
})();
//</script>
