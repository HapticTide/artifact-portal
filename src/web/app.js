/**
 * Artifact Portal 前端逻辑
 */

class ArtifactPortal {
    constructor() {
        // 状态
        this.builds = [];
        this.currentBuild = null;
        this.skipDays = 0;  // 已跳过的天数（用于分页）
        this.daysPerLoad = 3;  // 每次加载的天数
        this.branch = '';
        this.config = null;

        // 图表实例
        this.iosChart = null;
        this.androidChart = null;

        // 统计面板状态
        this.statsLoaded = false;

        // DOM 元素缓存
        this.els = {};
    }

    /**
     * 初始化
     */
    async init() {
        this.cacheElements();
        this.setupTheme();
        this.bindEvents();

        await this.loadConfig();
        await this.loadBuilds();
        await this.loadBranches();

        // 根据设备类型设置默认折叠状态
        this.setupPlatformDisplay();

        this.handleHashChange();
    }

    /**
     * API 已保证 iOS 身份为 pre / production；未知值只显示固定占位，避免拼接外部输入。
     * @param {string|undefined|null} env
     * @returns {string} HTML
     */
    renderEnvBadge(env) {
        if (env === 'pre') {
            return '<span class="env-badge env-badge-pre">pre</span>';
        }
        if (env === 'production') {
            return '<span class="env-badge env-badge-production">production</span>';
        }
        return '<span class="env-badge env-badge-unknown">unknown</span>';
    }

    /**
     * 缓存 DOM 元素
     */
    cacheElements() {
        this.els = {
            // 状态
            loading: document.getElementById('loading'),
            emptyState: document.getElementById('empty-state'),

            // 主题
            themeToggle: document.getElementById('theme-toggle'),
            themeIcon: document.querySelector('.theme-icon'),

            // 统计面板
            statsPanel: document.getElementById('stats-panel'),
            statsPanelToggle: document.getElementById('stats-panel-toggle'),
            statsPlatformTabs: document.getElementById('stats-platform-tabs'),
            statsCharts: document.getElementById('stats-charts'),
            iosChartContainer: document.getElementById('ios-chart-container'),
            androidChartContainer: document.getElementById('android-chart-container'),

            // 标题和图标
            appIcon: document.getElementById('app-icon'),
            appName: document.querySelector('.app-name'),

            // 最新构建
            latestBuild: document.getElementById('latest-build'),
            latestPlatformTabs: document.getElementById('latest-platform-tabs'),

            // iOS
            iosSection: document.getElementById('ios-section'),
            iosQr: document.getElementById('ios-qr'),
            iosInstallBtn: document.getElementById('ios-install-btn'),
            iosCopyBtn: document.getElementById('ios-copy-btn'),
            iosDownloadBtn: document.getElementById('ios-download-btn'),

            // Android
            androidSection: document.getElementById('android-section'),
            androidQr: document.getElementById('android-qr'),
            androidDownloadBtn: document.getElementById('android-download-btn'),
            androidMappingBtn: document.getElementById('android-mapping-btn'),
            androidMappingDesktopBtn: document.getElementById('android-mapping-desktop-btn'),
            androidCopyBtn: document.getElementById('android-copy-btn'),

            // 移动端全局平台切换
            globalPlatformTabs: document.getElementById('global-platform-tabs'),

            // 所有构建
            history: document.getElementById('history'),
            historyToggle: document.getElementById('history-toggle'),
            iosBranchFilter: document.getElementById('ios-branch-filter'),
            iosEnvFilter: document.getElementById('ios-env-filter'),
            androidBranchFilter: document.getElementById('android-branch-filter'),
            mobileBranchFilter: document.getElementById('mobile-branch-filter'),
            mobileEnvFilter: document.getElementById('mobile-env-filter'),
            versionRows: document.getElementById('version-rows'),
            loadMore: document.getElementById('load-more'),

            // 选中版本详情
            selectedDetail: document.getElementById('selected-detail'),
            selectedDetailContent: document.getElementById('selected-detail-content'),
            closeDetailBtn: document.getElementById('close-detail'),

            // Toast
            toast: document.getElementById('toast'),

            desktopEntryBtn: document.getElementById('desktop-entry-btn'),

            // E2EE Lab 桌面工具 入口 + 弹窗
            labEntryBtn: document.getElementById('lab-entry-btn'),
            labModal: document.getElementById('lab-modal'),
            labModalClose: document.getElementById('lab-modal-close'),
            labModalBackdrop: document.getElementById('lab-modal-backdrop'),
            labDlMac: document.getElementById('lab-dl-mac'),
            labDlWin: document.getElementById('lab-dl-win'),
            labDlLinux: document.getElementById('lab-dl-linux'),
            labVersion: document.getElementById('lab-version'),
            labVersionWrap: document.getElementById('lab-version-wrap'),
        };

        // 分支 / 身份筛选状态
        this.iosBranch = '';
        this.iosEnv = '';
        this.androidBranch = '';

        // 移动端当前选中的平台（全局）
        this.mobilePlatform = 'ios';
    }

    /**
     * 设置主题
     */
    setupTheme() {
        // 从 localStorage 读取主题偏好
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            document.documentElement.setAttribute('data-theme', savedTheme);
            this.updateThemeIcon(savedTheme);
        }
    }

    /**
     * 检测当前设备平台
     * @returns {'ios' | 'android' | 'other'}
     */
    detectPlatform() {
        const ua = navigator.userAgent.toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) {
            return 'ios';
        } else if (/android/.test(ua)) {
            return 'android';
        }
        return 'other';
    }

    /**
     * 更新主题图标
     */
    updateThemeIcon(theme) {
        const isDark = theme === 'dark' ||
            (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
        this.els.themeIcon.textContent = isDark ? '☀️' : '🌙';
    }

    /**
     * 切换主题
     */
    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme');
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

        let newTheme;
        if (!current) {
            // 当前跟随系统，切换到反向
            newTheme = systemDark ? 'light' : 'dark';
        } else if (current === 'dark') {
            newTheme = 'light';
        } else {
            newTheme = 'dark';
        }

        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        this.updateThemeIcon(newTheme);
    }

    /**
     * 打开 E2EE Lab 桌面工具弹窗
     * 填三平台下载链接（指向 VPS /desktop 稳定名）+ 从自动更新清单动态取版本号
     */
    openLabModal() {
        if (!this.els.labModal) return;

        const base = (this.config?.publicBaseUrl || window.location.origin).replace(/\/$/, '');
        if (this.els.labDlMac) this.els.labDlMac.href = `${base}/desktop/imwe-e2ee-lab-latest.dmg`;
        if (this.els.labDlWin) this.els.labDlWin.href = `${base}/desktop/imwe-e2ee-lab-latest-setup.exe`;
        if (this.els.labDlLinux) this.els.labDlLinux.href = `${base}/desktop/imwe-e2ee-lab-latest.AppImage`;

        // 版本号从自动更新清单（/updater/latest.json）动态取，避免再多一处版本源；拉取失败则不显示。
        // 用相对路径确保同源（publicBaseUrl 可能与页面 origin 不同，绝对 URL 会触发跨源 fetch 失败）。
        fetch('/updater/latest.json', { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .then(j => {
                if (j?.version && this.els.labVersion && this.els.labVersionWrap) {
                    this.els.labVersion.textContent = `v${j.version}`;
                    this.els.labVersionWrap.hidden = false;
                }
            })
            .catch(() => { });

        this.els.labModal.hidden = false;
    }

    /**
     * 关闭 E2EE Lab 桌面工具弹窗
     */
    closeLabModal() {
        if (this.els.labModal) this.els.labModal.hidden = true;
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // 主题切换
        this.els.themeToggle.addEventListener('click', () => this.toggleTheme());

        this.els.desktopEntryBtn?.addEventListener('click', () => {
            window.open("http://172.16.41.142:3000/");
        });

        // E2EE Lab 桌面工具 入口弹窗
        this.els.labEntryBtn?.addEventListener('click', () => this.openLabModal());
        this.els.labModalClose?.addEventListener('click', () => this.closeLabModal());
        this.els.labModalBackdrop?.addEventListener('click', () => this.closeLabModal());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.els.labModal && !this.els.labModal.hidden) {
                this.closeLabModal();
            }
        });

        // 统计面板折叠/展开
        this.els.statsPanelToggle?.addEventListener('click', (e) => {
            e.preventDefault();
            // 清除可能的文本选中
            window.getSelection()?.removeAllRanges();
            this.toggleStatsPanel();
        });

        // 移动端"所有构建"卡片折叠/展开
        this.els.historyToggle?.addEventListener('click', (e) => {
            e.preventDefault();
            window.getSelection()?.removeAllRanges();
            this.toggleHistoryPanel();
        });

        // 移动端全局平台切换
        this.els.globalPlatformTabs?.querySelectorAll('.platform-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                e.preventDefault();
                window.getSelection()?.removeAllRanges();
                this.switchMobilePlatform(tab.dataset.platform);
            });
        });

        // iOS 安装
        this.els.iosInstallBtn.addEventListener('click', () => this.installIOS());

        // 复制按钮
        this.els.iosCopyBtn.addEventListener('click', () => {
            this.copyToClipboard(this.els.iosCopyBtn.dataset.url);
        });
        this.els.androidCopyBtn.addEventListener('click', () => {
            this.copyToClipboard(this.els.androidCopyBtn.dataset.url);
        });

        // 二维码折叠（移动端 - 新结构）
        document.querySelectorAll('.qr-toggle-btn[data-target]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = btn.dataset.target;
                const content = document.getElementById(targetId);
                if (content) {
                    content.classList.toggle('collapsed');
                    btn.classList.toggle('expanded');
                }
            });
        });

        // 兼容旧结构（桌面端使用）
        document.querySelectorAll('.qr-collapsible .qr-toggle-btn').forEach(btn => {
            if (!btn.dataset.target) {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const container = btn.closest('.qr-collapsible');
                    container?.classList.toggle('collapsed');
                });
            }
        });

        // 桌面端复制链接按钮（二维码下方）
        document.querySelectorAll('.desktop-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sourceId = btn.dataset.copyFrom;
                const sourceBtn = document.getElementById(sourceId);
                if (sourceBtn?.dataset.url) {
                    this.copyToClipboard(sourceBtn.dataset.url);
                }
            });
        });

        // iOS 分支筛选（桌面端）
        this.els.iosBranchFilter?.addEventListener('change', () => {
            this.iosBranch = this.els.iosBranchFilter.value;
            this.renderVersionLists();
        });

        // iOS 身份筛选（pre / production）
        this.els.iosEnvFilter?.addEventListener('change', () => {
            this.iosEnv = this.els.iosEnvFilter.value;
            if (this.els.mobileEnvFilter) this.els.mobileEnvFilter.value = this.iosEnv;
            void this.loadBuilds(false);
        });

        // Android 分支筛选（桌面端）
        this.els.androidBranchFilter?.addEventListener('change', () => {
            this.androidBranch = this.els.androidBranchFilter.value;
            this.renderVersionLists();
        });

        // 移动端分支筛选
        this.els.mobileBranchFilter?.addEventListener('change', () => {
            const branch = this.els.mobileBranchFilter.value;
            // 设置当前平台的分支
            if (this.mobilePlatform === 'ios') {
                this.iosBranch = branch;
            } else {
                this.androidBranch = branch;
            }
            this.renderVersionLists();
        });

        // 移动端身份筛选
        this.els.mobileEnvFilter?.addEventListener('change', () => {
            this.iosEnv = this.els.mobileEnvFilter.value;
            if (this.els.iosEnvFilter) this.els.iosEnvFilter.value = this.iosEnv;
            void this.loadBuilds(false);
        });

        // 关闭详情卡片
        this.els.closeDetailBtn?.addEventListener('click', () => {
            this.hideSelectedDetail();
            window.location.hash = '';
        });

        // 加载更多按钮
        this.els.loadMore?.addEventListener('click', () => this.loadMoreBuilds());

        // 监听 hash 变化
        window.addEventListener('hashchange', () => this.handleHashChange());

        // 监听系统主题变化
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            const savedTheme = localStorage.getItem('theme');
            if (!savedTheme) {
                this.updateThemeIcon(null);
            }
        });
    }

    /**
     * 切换移动端平台（全局切换）
     * 同时影响：最新构建、所有构建、包体积统计
     */
    switchMobilePlatform(platform) {
        this.mobilePlatform = platform;

        // 更新全局标签状态
        this.els.globalPlatformTabs?.querySelectorAll('.platform-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.platform === platform);
        });

        // 更新最新构建区域显示
        this.updateLatestPlatformVisibility();

        // 更新移动端分支筛选器
        this.updateMobileBranchFilter();
        this.updateMobileEnvFilterVisibility();

        // 重新渲染版本列表
        this.renderVersionLists();

        // 更新包体积统计图表显示
        this.updateStatsPlatformVisibility();
    }

    /**
     * 更新最新构建区域的平台可见性
     */
    updateLatestPlatformVisibility() {
        const platform = this.detectPlatform();
        const isMobile = platform === 'ios' || platform === 'android';

        if (isMobile) {
            // 移动端：根据选中的标签显示单个平台
            const showIos = this.mobilePlatform === 'ios';
            const showAndroid = this.mobilePlatform === 'android';

            // 只有当数据可用时才显示
            if (this.latestByPlatform?.ios?.platforms?.ios?.available) {
                this.els.iosSection.hidden = !showIos;
            }
            if (this.latestByPlatform?.android?.platforms?.android?.available) {
                this.els.androidSection.hidden = !showAndroid;
            }
        }
        // 桌面端：由 renderLatestBuild 控制，根据数据可用性显示
    }

    /**
     * 更新包体积统计的平台可见性（移动端）
     */
    updateStatsPlatformVisibility() {
        const platform = this.detectPlatform();
        const isMobile = platform === 'ios' || platform === 'android';

        if (isMobile) {
            const statsCharts = document.getElementById('stats-charts');
            if (statsCharts) {
                statsCharts.classList.toggle('show-ios', this.mobilePlatform === 'ios');
                statsCharts.classList.toggle('show-android', this.mobilePlatform === 'android');
            }
        }
    }

    /**
     * 更新移动端分支筛选器
     */
    updateMobileBranchFilter() {
        if (!this.els.mobileBranchFilter) return;

        // 根据当前平台切换分支列表
        const sourceSelect = this.mobilePlatform === 'ios'
            ? this.els.iosBranchFilter
            : this.els.androidBranchFilter;

        if (!sourceSelect) return;

        // 复制选项
        this.els.mobileBranchFilter.innerHTML = sourceSelect.innerHTML;

        // 设置当前选中值
        const currentBranch = this.mobilePlatform === 'ios' ? this.iosBranch : this.androidBranch;
        this.els.mobileBranchFilter.value = currentBranch;
    }

    /** Android 没有 iOS 包身份概念，切换平台时隐藏无效筛选器。 */
    updateMobileEnvFilterVisibility() {
        if (!this.els.mobileEnvFilter) return;
        this.els.mobileEnvFilter.hidden = this.mobilePlatform !== 'ios';
    }

    /**
     * 根据设备类型设置默认平台显示
     * 移动端显示全局平台切换，桌面端隐藏
     */
    setupPlatformDisplay() {
        const platform = this.detectPlatform();
        const isMobile = platform === 'ios' || platform === 'android';

        if (isMobile) {
            // 移动端：显示全局平台切换
            if (this.els.globalPlatformTabs) {
                this.els.globalPlatformTabs.hidden = false;
            }

            // 移动端：默认收起"所有构建"卡片
            if (this.els.history) {
                this.els.history.classList.add('collapsed');
            }

            // 设置默认选中的平台（根据设备类型）
            this.mobilePlatform = platform;

            // 更新标签状态
            this.els.globalPlatformTabs?.querySelectorAll('.platform-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.platform === platform);
            });

            // 更新移动端分支筛选器
            this.updateMobileBranchFilter();
            this.updateMobileEnvFilterVisibility();

            // 重新渲染内容以匹配选中的平台
            this.updateLatestPlatformVisibility();
            this.renderVersionLists();
            this.updateStatsPlatformVisibility();
        } else {
            // 桌面端：隐藏全局平台切换
            if (this.els.globalPlatformTabs) {
                this.els.globalPlatformTabs.hidden = true;
            }

            // 桌面端：确保"所有构建"卡片不收起
            if (this.els.history) {
                this.els.history.classList.remove('collapsed');
            }
        }
    }

    /**
     * 加载配置
     */
    async loadConfig() {
        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            if (data.success) {
                this.config = data.data;

                // 设置应用名称
                if (this.config.appName) {
                    this.els.appName.textContent = this.config.appName;
                    document.title = this.config.appName;
                }

                // 设置 favicon（如果配置了自定义图标）
                if (this.config.appIcon) {
                    this._updateFavicon(this.config.appIcon);
                    // 同时设置左上角图标为配置的默认图标
                    // 后续 renderLatestBuild 会尝试用 IPA 解析的图标覆盖
                    this._setAppIconImage(this.config.appIcon);
                }

                // 注意：应用图标会在 renderLatestBuild 中根据优先级更新
                // 优先级：IPA 解析 → build.json → 全局配置 → 默认 📦
            }
        } catch (err) {
            console.error('加载配置失败:', err);
        }
    }

    /**
     * 更新 favicon 和 apple-touch-icon
     * @param {string} iconUrl - 图标 URL
     */
    _updateFavicon(iconUrl) {
        const favicon = document.getElementById('favicon');
        const appleTouchIcon = document.getElementById('apple-touch-icon');

        if (favicon) {
            favicon.href = iconUrl;
        }
        if (appleTouchIcon) {
            appleTouchIcon.href = iconUrl;
        }
    }

    /**
     * 生成 iOS 安装链接
     * 
     * 如果配置了 plist 代理服务（iosPlistProxyUrl），将使用代理服务生成 manifest
     * 这是因为 iOS 需要受信任的 HTTPS 证书来下载 manifest.plist
     * 
     * @param {object} ios - iOS 构建信息
     * @param {string} ios.manifest - manifest 路径
     * @param {string} ios.bundleId - Bundle ID
     * @param {string} ios.version - 版本号
     * @param {string} ios.build - 构建号
     * @param {boolean} ios.hasStaticManifest - 是否有静态 manifest
     * @param {string} ios.ipa - IPA 文件路径
     * @returns {string} itms-services:// 安装链接
     */
    getIosInstallUrl(ios) {
        // 如果配置了 plist 代理服务
        if (this.config.iosPlistProxyUrl) {
            // 使用代理服务生成 manifest
            // 代理服务期望的参数：host, downloadPath, bundleId, AppName, logo
            const downloadPath = `/download/${ios.ipa}`;
            // 优先使用从 IPA 解析的 appName，否则回退到配置
            const appName = ios.appName || this.config.iosDisplayName || this.config.appName || 'App';
            const bundleId = ios.bundleId || 'com.example.app';

            // 从 publicBaseUrl 中提取 host（包含端口）
            let host = '';
            try {
                const url = new URL(this.config.publicBaseUrl);
                host = url.host; // 包含端口
            } catch (e) {
                console.error('解析 publicBaseUrl 失败:', e);
                host = 'localhost';
            }

            // 构建代理 URL
            const params = new URLSearchParams();
            params.set('host', host);
            params.set('downloadPath', downloadPath);
            params.set('bundleId', bundleId);
            params.set('appName', appName);

            // 如果配置了 logo，添加 logo 参数
            if (this.config.iosPlistLogo) {
                params.set('logo', this.config.iosPlistLogo);
            }

            const proxyUrl = `${this.config.iosPlistProxyUrl}?${params.toString()}`;
            return `itms-services://?action=download-manifest&url=${encodeURIComponent(proxyUrl)}`;
        }

        // 使用本地 manifest 服务
        const manifestUrl = ios.hasStaticManifest
            ? `${this.config.publicBaseUrl}/download/${ios.manifest}`
            : `${this.config.publicBaseUrl}/${ios.manifest}`;
        return `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    }

    /**
     * 获取 Android mapping 文件下载链接
     * @param {object} android - Android 平台数据
     * @returns {string|null} 没有 mapping 时返回 null
     */
    getMappingUrl(android) {
        if (!android?.mapping) return null;
        return `${this.config.publicBaseUrl}/download/${android.mapping}`;
    }

    /**
     * 加载构建列表（按天数分页）
     * @param {boolean} append - 是否追加模式（加载更多）
     * @param {object} options - 可选的筛选参数
     * @param {string} options.platform - 平台筛选（ios/android）
     * @param {string} options.branch - 分支筛选
     */
    async loadBuilds(append = false, options = {}) {
        if (!append) {
            this.els.loading.hidden = false;
            this.els.latestBuild.hidden = true;
            this.els.history.hidden = true;
            this.els.emptyState.hidden = true;
            this.skipDays = 0; // 重置跳过天数
        }

        // 合并筛选参数
        const platform = options.platform || null;
        const branch = options.branch || this.branch;

        try {
            // 构建请求参数（按天数分页）
            const params = new URLSearchParams({
                days: this.daysPerLoad,
                skipDays: this.skipDays,
            });
            if (branch) {
                params.set('branch', branch);
            }
            if (platform) {
                params.set('platform', platform);
            }
            if (this.iosEnv) {
                params.set('env', this.iosEnv);
            }

            // 身份筛选为空时不传 env，让服务端返回时间上真正最新（pre 或 production）
            const latestParams = new URLSearchParams();
            if (this.iosEnv) {
                latestParams.set('env', this.iosEnv);
            }
            if (branch) {
                latestParams.set('branch', branch);
            }

            const [latestRes, buildsRes] = await Promise.all([
                append ? Promise.resolve(null) : fetch(`/api/builds/latest?${latestParams}`),
                fetch(`/api/builds?${params}`),
            ]);

            // 处理最新构建数据（iOS + Android 分别的最新）
            if (!append && latestRes) {
                const latestData = await latestRes.json();
                if (latestData.success) {
                    this.latestByPlatform = latestData.data;
                }
            }

            const data = await buildsRes.json();

            if (!data.success) {
                throw new Error(data.error);
            }

            const { builds, total, hasMore, loadedDays } = data.data;

            if (append) {
                this.builds = [...this.builds, ...builds];
            } else {
                this.builds = builds;
            }

            // 更新跳过天数，用于下次加载
            this.skipDays += loadedDays;

            this.els.loading.hidden = true;

            // 检查是否完全没有构建数据
            const hasIosLatest = this.latestByPlatform?.ios != null;
            const hasAndroidLatest = this.latestByPlatform?.android != null;
            const hasAnyData = this.builds.length > 0 || hasIosLatest || hasAndroidLatest;

            if (!hasAnyData) {
                this.els.emptyState.hidden = false;
                this.els.latestBuild.hidden = true;
                this.els.history.hidden = true;
                // 暂无构建时隐藏包体积统计入口
                if (this.els.statsPanel) {
                    this.els.statsPanel.hidden = true;
                }
                return;
            }

            // 有数据时确保隐藏空状态，显示统计入口
            this.els.emptyState.hidden = true;
            if (this.els.statsPanel) {
                this.els.statsPanel.hidden = false;
            }

            // 渲染最新构建（同时显示 iOS 和 Android）
            if (!append) {
                this.renderLatestBuild();
            }

            // 收集最新构建 ID（用于在列表中标记）
            this.updateLatestIds();

            // 渲染所有构建列表（包含最新构建，带标识）
            this.renderHistory(append ? builds : this.builds, append);

            // 加载更多按钮
            this.els.loadMore.hidden = !hasMore;

        } catch (err) {
            console.error('加载构建失败:', err);
            this.els.loading.hidden = true;
            this.els.emptyState.hidden = false;
        }
    }

    updateLatestIds() {
        this.latestIds = new Set();
        if (this.latestByPlatform?.ios) this.latestIds.add(this.latestByPlatform.ios.id);
        if (this.latestByPlatform?.android) this.latestIds.add(this.latestByPlatform.android.id);
    }

    /**
     * 加载更多构建（按天数分页）
     */
    async loadMoreBuilds() {
        // 禁用按钮防止重复点击
        this.els.loadMore.disabled = true;
        this.els.loadMore.textContent = '加载中...';

        try {
            // skipDays 已在 loadBuilds 中自动更新
            await this.loadBuilds(true);
        } finally {
            // 恢复按钮状态
            this.els.loadMore.disabled = false;
            this.els.loadMore.textContent = '加载更多';
        }
    }

    /**
     * 加载分支列表（现在返回分平台的分支）
     */
    async loadBranches() {
        try {
            const res = await fetch('/api/branches');
            const data = await res.json();

            if (data.success && data.data) {
                const branches = data.data;

                // iOS 分支
                const iosBranches = branches.ios || branches.all || [];
                this.populateBranchSelect(this.els.iosBranchFilter, iosBranches);

                // Android 分支
                const androidBranches = branches.android || branches.all || [];
                this.populateBranchSelect(this.els.androidBranchFilter, androidBranches);
            }
        } catch (err) {
            console.error('加载分支失败:', err);
        }
    }

    /**
     * 填充分支选择器
     */
    populateBranchSelect(selectEl, branches) {
        if (!selectEl || !Array.isArray(branches)) return;

        // 清除现有选项（保留第一个"全部分支"）
        while (selectEl.options.length > 1) {
            selectEl.remove(1);
        }

        branches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch;
            option.textContent = branch;
            selectEl.appendChild(option);
        });
    }

    /**
     * 渲染最新构建区域
     * @param {object} [singleBuild] - 可选，指定单个构建时传入
     * 
     * 不传参数：同时显示 iOS 和 Android 的最新版本
     * 传入 singleBuild：显示指定构建的详情
     */
    renderLatestBuild(singleBuild = null) {
        // 确定要显示的 iOS 和 Android 构建
        let iosBuild = null;
        let androidBuild = null;

        if (singleBuild) {
            // 单个构建模式：根据构建的平台决定显示哪个
            if (singleBuild.platforms?.ios?.available) {
                iosBuild = singleBuild;
            }
            if (singleBuild.platforms?.android?.available) {
                androidBuild = singleBuild;
            }
        } else {
            // 默认模式：使用各平台最新
            iosBuild = this.latestByPlatform?.ios;
            androidBuild = this.latestByPlatform?.android;
        }

        // 更新应用图标（优先从 iOS 构建获取）
        if (iosBuild) {
            this.updateAppIcon(iosBuild);
        } else if (androidBuild) {
            // Android 没有图标解析，使用全局配置或默认
            this._setAppIconImage(this.config?.appIcon || '');
        }

        // 检测设备类型
        const platform = this.detectPlatform();
        const isMobile = platform === 'ios' || platform === 'android';

        // iOS 平台
        const iosAvailable = iosBuild?.platforms?.ios?.available;
        if (iosAvailable) {
            const ios = iosBuild.platforms.ios;

            // 更新 iOS 版本信息（版本+体积同行，时间换行）
            const iosVersionEl = document.getElementById('ios-version-info');
            if (iosVersionEl) {
                const size = ios.size || '';
                const envBadge = this.renderEnvBadge(ios.env);
                iosVersionEl.innerHTML = `
                    <div class="version-item-info">
                        <div class="version-item-header">
                            <span class="version-item-version">${ios.version} (${ios.build})</span>
                            ${envBadge}
                            ${size ? `<span class="version-item-size">${size}</span>` : ''}
                        </div>
                        <div class="version-item-time">${this.formatTime(iosBuild.time)}</div>
                    </div>
                    <span class="version-item-branch">${ios.branch || 'dev'}</span>
                `;
            }

            // 使用统一的方法生成安装链接
            const installUrl = this.getIosInstallUrl(ios);
            const downloadUrl = `${this.config.publicBaseUrl}/download/${ios.ipa}`;

            this.els.iosQr.src = `/qr?text=${encodeURIComponent(installUrl)}&size=200`;
            this.els.iosCopyBtn.dataset.url = installUrl;
            this.els.iosDownloadBtn.href = downloadUrl;
        }

        // Android 平台
        const androidAvailable = androidBuild?.platforms?.android?.available;
        if (androidAvailable) {
            const android = androidBuild.platforms.android;

            // 更新 Android 版本信息（版本+体积同行，时间换行）
            const androidVersionEl = document.getElementById('android-version-info');
            if (androidVersionEl) {
                const size = android.size || '';
                androidVersionEl.innerHTML = `
                    <div class="version-item-info">
                        <div class="version-item-header">
                            <span class="version-item-version">${android.version} (${android.build})</span>
                            ${size ? `<span class="version-item-size">${size}</span>` : ''}
                        </div>
                        <div class="version-item-time">${this.formatTime(androidBuild.time)}</div>
                    </div>
                    <span class="version-item-branch">${android.branch || 'dev'}</span>
                `;
            }

            // APK 下载 URL（使用相对路径）
            const downloadUrl = `${this.config.publicBaseUrl}/download/${android.apk}`;

            this.els.androidQr.src = `/qr?text=${encodeURIComponent(downloadUrl)}&size=200`;
            this.els.androidDownloadBtn.href = downloadUrl;
            this.els.androidCopyBtn.dataset.url = downloadUrl;

            // mapping 文件：仅在存在时显示（移动端次要操作行 + 桌面端二维码下方，各一个按钮）
            const mappingUrl = this.getMappingUrl(android);
            const mappingText = mappingUrl
                ? (android.mappingSize ? `下载 mapping (${android.mappingSize})` : '下载 mapping')
                : '';
            [this.els.androidMappingBtn, this.els.androidMappingDesktopBtn].forEach(btn => {
                if (!btn) return;
                if (mappingUrl) {
                    btn.href = mappingUrl;
                    btn.textContent = mappingText;
                    btn.hidden = false;
                } else {
                    btn.removeAttribute('href');
                    btn.hidden = true;
                }
            });
        }

        // 设置平台区域可见性
        if (isMobile) {
            // 移动端：根据选中的标签显示单个平台
            const showIos = this.mobilePlatform === 'ios' && iosAvailable;
            const showAndroid = this.mobilePlatform === 'android' && androidAvailable;

            this.els.iosSection.hidden = !showIos;
            this.els.androidSection.hidden = !showAndroid;

            // 如果当前选中的平台不可用，切换到另一个平台
            if (this.mobilePlatform === 'ios' && !iosAvailable && androidAvailable) {
                this.switchMobilePlatform('android');
            } else if (this.mobilePlatform === 'android' && !androidAvailable && iosAvailable) {
                this.switchMobilePlatform('ios');
            }
        } else {
            // 桌面端：根据数据可用性显示
            this.els.iosSection.hidden = !iosAvailable;
            this.els.androidSection.hidden = !androidAvailable;
        }

        // 根据设备类型调整平台卡片顺序
        this.reorderPlatformSections();

        this.els.latestBuild.hidden = false;
    }

    /**
     * 根据设备类型调整平台卡片顺序
     * iOS 设备优先显示 iOS，Android 设备优先显示 Android
     */
    reorderPlatformSections() {
        const platform = this.detectPlatform();
        const platformsContainer = this.els.iosSection?.parentElement;

        if (!platformsContainer) return;

        // Android 设备：将 Android 卡片移到前面
        if (platform === 'android') {
            if (this.els.androidSection && !this.els.androidSection.hidden) {
                platformsContainer.insertBefore(this.els.androidSection, this.els.iosSection);
            }
        }
        // iOS 设备或其他设备：保持 iOS 在前（默认顺序）
        // 不需要额外操作，因为 HTML 默认顺序就是 iOS 在前
    }

    /**
     * 渲染所有构建列表（双列布局：iOS 左，Android 右）
     * 按天分组展示
     */
    renderHistory(builds, append = false) {
        // 保存构建数据用于筛选
        if (append) {
            // 追加模式：合并新数据
            this.allBuilds = [...(this.allBuilds || []), ...builds];
        } else {
            // 重置模式
            this.allBuilds = builds;
        }
        this.renderVersionLists();
    }

    /**
     * 渲染版本列表（根据筛选条件）
     * 按日期分组，每行包含 iOS 和 Android 两个单元格对齐
     */
    renderVersionLists() {
        if (!this.allBuilds || this.allBuilds.length === 0) {
            this.els.history.hidden = true;
            return;
        }

        // 分离并筛选 iOS 和 Android 构建
        let iosBuilds = this.allBuilds.filter(b => b.platforms?.ios?.available);
        let androidBuilds = this.allBuilds.filter(b => b.platforms?.android?.available);

        // 应用分支 / 身份筛选
        if (this.iosBranch) {
            iosBuilds = iosBuilds.filter(b => b.platforms.ios.branch === this.iosBranch);
        }
        if (this.iosEnv) {
            iosBuilds = iosBuilds.filter(b => b.platforms.ios.env === this.iosEnv);
        }
        if (this.androidBranch) {
            androidBuilds = androidBuilds.filter(b => b.platforms.android.branch === this.androidBranch);
        }

        // 检测设备类型
        const platform = this.detectPlatform();
        const isMobile = platform === 'ios' || platform === 'android';

        if (isMobile) {
            // 移动端：只显示当前选中平台的构建
            const builds = this.mobilePlatform === 'ios' ? iosBuilds : androidBuilds;
            this.renderSingleColumnList(builds, this.mobilePlatform);
        } else {
            // 桌面端：双列对齐显示
            // 获取所有日期（合并 iOS 和 Android）
            const allDates = new Set();
            iosBuilds.forEach(b => allDates.add(this.getDateKey(b.time)));
            androidBuilds.forEach(b => allDates.add(this.getDateKey(b.time)));
            const sortedDates = Array.from(allDates).sort((a, b) => b.localeCompare(a));

            // 按日期分组
            const iosByDate = this.groupByDate(iosBuilds);
            const androidByDate = this.groupByDate(androidBuilds);

            // 渲染按日期对齐的双列视图
            this.renderDateAlignedRows(sortedDates, iosByDate, androidByDate);
        }

        this.els.history.hidden = false;
    }

    /**
     * 渲染单列版本列表（移动端使用）
     */
    renderSingleColumnList(builds, platform) {
        const container = document.getElementById('version-rows');
        if (!container) return;

        container.innerHTML = '';

        if (builds.length === 0) {
            container.innerHTML = '<div class="date-row"><div class="date-row-header">暂无构建</div></div>';
            return;
        }

        // 按日期分组
        const buildsByDate = this.groupByDate(builds);
        const sortedDates = Object.keys(buildsByDate).sort((a, b) => b.localeCompare(a));

        const fragment = document.createDocumentFragment();

        sortedDates.forEach(dateKey => {
            const buildsForDate = buildsByDate[dateKey] || [];

            // 创建日期行
            const dateRow = document.createElement('div');
            dateRow.className = 'date-row';

            // 日期头
            const header = document.createElement('div');
            header.className = 'date-row-header';
            header.textContent = this.formatDateGroupTitle(dateKey);
            dateRow.appendChild(header);

            // 构建列表
            buildsForDate.forEach(build => {
                const rowContent = document.createElement('div');
                rowContent.className = 'date-row-content';

                const cell = document.createElement('div');
                cell.className = `platform-cell ${platform}`;
                const item = this.renderVersionItem(build, platform);
                cell.appendChild(item);
                rowContent.appendChild(cell);

                dateRow.appendChild(rowContent);
            });

            fragment.appendChild(dateRow);
        });

        container.appendChild(fragment);
    }

    /**
     * 渲染按日期对齐的行（桌面端双列显示）
     */
    renderDateAlignedRows(sortedDates, iosByDate, androidByDate) {
        const container = document.getElementById('version-rows');
        if (!container) return;

        container.innerHTML = '';

        // 过滤掉两个平台都没有构建的日期
        const validDates = sortedDates.filter(dateKey => {
            const iosCount = (iosByDate[dateKey] || []).length;
            const androidCount = (androidByDate[dateKey] || []).length;
            return iosCount > 0 || androidCount > 0;
        });

        // 检查是否有任何构建
        if (validDates.length === 0) {
            container.innerHTML = '<div class="date-row"><div class="date-row-header">暂无构建</div></div>';
            return;
        }

        const fragment = document.createDocumentFragment();

        validDates.forEach(dateKey => {
            const iosBuildsForDate = iosByDate[dateKey] || [];
            const androidBuildsForDate = androidByDate[dateKey] || [];

            // 创建日期行
            const dateRow = document.createElement('div');
            dateRow.className = 'date-row';

            // 日期头
            const header = document.createElement('div');
            header.className = 'date-row-header';
            header.textContent = this.formatDateGroupTitle(dateKey);
            dateRow.appendChild(header);

            // 双列内容（按构建数量较多的平台决定行数）
            const maxCount = Math.max(iosBuildsForDate.length, androidBuildsForDate.length);

            for (let i = 0; i < maxCount; i++) {
                const rowContent = document.createElement('div');
                rowContent.className = 'date-row-content';

                // iOS 单元格
                const iosCell = document.createElement('div');
                iosCell.className = 'platform-cell ios';
                if (iosBuildsForDate[i]) {
                    const item = this.renderVersionItem(iosBuildsForDate[i], 'ios');
                    iosCell.appendChild(item);
                } else if (i === 0 && iosBuildsForDate.length === 0) {
                    // iOS 当日无构建，在第一行显示提示
                    iosCell.classList.add('empty');
                    iosCell.textContent = '当日无构建';
                }
                // 其他行留空
                rowContent.appendChild(iosCell);

                // Android 单元格
                const androidCell = document.createElement('div');
                androidCell.className = 'platform-cell android';
                if (androidBuildsForDate[i]) {
                    const item = this.renderVersionItem(androidBuildsForDate[i], 'android');
                    androidCell.appendChild(item);
                } else if (i === 0 && androidBuildsForDate.length === 0) {
                    // Android 当日无构建，在第一行显示提示
                    androidCell.classList.add('empty');
                    androidCell.textContent = '当日无构建';
                }
                // 其他行留空
                rowContent.appendChild(androidCell);

                dateRow.appendChild(rowContent);
            }

            fragment.appendChild(dateRow);
        });

        container.appendChild(fragment);
    }

    /**
     * 渲染单个版本项
     */
    renderVersionItem(build, platform) {
        const platformData = build.platforms[platform];
        const wrapper = document.createElement('div');
        wrapper.className = 'version-item-wrapper';
        wrapper.dataset.dir = build.dir;
        wrapper.dataset.platform = platform;

        const item = document.createElement('div');
        item.className = 'version-item';

        // 检查是否是最新构建
        const isLatest = this.latestIds?.has(build.id);
        if (isLatest) {
            item.classList.add('latest');
            wrapper.classList.add('latest');
        }

        // 格式化时间
        const buildTime = this.formatBuildTime(build.time);

        // 包大小
        const size = platformData.size || '';

        const envBadge = platform === 'ios' ? this.renderEnvBadge(platformData.env) : '';
        item.innerHTML = `
            <div class="version-item-info">
                <div class="version-item-header">
                    ${isLatest ? '<span class="latest-badge">最新</span>' : ''}
                    <span class="version-item-version">${platformData.version} (${platformData.build})</span>
                    ${envBadge}
                    ${size ? `<span class="version-item-size">${size}</span>` : ''}
                </div>
                <div class="version-item-time">${buildTime}</div>
            </div>
            <div class="version-item-right">
                <span class="version-item-branch">${platformData.branch || 'dev'}</span>
                <span class="version-item-toggle">▼</span>
            </div>
        `;

        wrapper.appendChild(item);

        // 创建展开内容区域
        const expandContent = this.createExpandContent(build, platform);
        wrapper.appendChild(expandContent);

        // 点击切换展开/收起
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleVersionItemExpand(wrapper);
        });

        return wrapper;
    }

    /**
     * 创建展开内容区域
     */
    createExpandContent(build, platform) {
        const platformData = build.platforms[platform];
        const content = document.createElement('div');
        content.className = 'version-item-expand';

        // 生成对应平台的链接
        let actionUrl = '';
        let actionText = '';
        let copyText = '';
        let mappingUrl = null;
        let ipaDownloadUrl = '';

        if (platform === 'ios') {
            actionUrl = this.getIosInstallUrl(platformData);
            actionText = '点击安装';
            copyText = '复制安装链接';
            ipaDownloadUrl = `${this.config.publicBaseUrl}/download/${platformData.ipa}`;
        } else {
            actionUrl = `${this.config.publicBaseUrl}/download/${platformData.apk}`;
            actionText = '下载 APK';
            copyText = '复制下载链接';
            mappingUrl = this.getMappingUrl(platformData);
        }

        content.innerHTML = `
            <div class="expand-qr">
                <img class="expand-qr-img" src="/qr?text=${encodeURIComponent(actionUrl)}&size=160" alt="${platform === 'ios' ? 'iOS 安装' : 'Android 下载'}二维码">
            </div>
            <div class="expand-actions">
                ${platform === 'ios'
                ? `<button class="btn btn-primary expand-install-btn" data-url="${actionUrl}">${actionText}</button>`
                : `<a href="${actionUrl}" class="btn btn-primary expand-download-btn" download>${actionText}</a>`
            }
                <div class="expand-link-actions">
                    <button class="btn-link expand-copy-btn" data-url="${actionUrl}">${copyText}</button>
                    ${platform === 'ios'
                    ? `<a href="${ipaDownloadUrl}" class="btn-link expand-ipa-download-btn" download>下载 IPA</a>`
                    : ''}
                    ${mappingUrl
                    ? `<a href="${mappingUrl}" class="btn-link expand-mapping-btn" download>下载 mapping${platformData.mappingSize ? ` (${platformData.mappingSize})` : ''}</a>`
                    : ''}
                </div>
            </div>
        `;

        // 绑定事件
        const installBtn = content.querySelector('.expand-install-btn');
        if (installBtn) {
            installBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.location.href = installBtn.dataset.url;
            });
        }

        const downloadBtn = content.querySelector('.expand-download-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        const mappingBtn = content.querySelector('.expand-mapping-btn');
        if (mappingBtn) {
            mappingBtn.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        const copyBtn = content.querySelector('.expand-copy-btn');
        if (copyBtn) {
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.copyToClipboard(copyBtn.dataset.url);
            });
        }

        return content;
    }

    /**
     * 切换版本项展开/收起
     */
    toggleVersionItemExpand(wrapper) {
        const isExpanded = wrapper.classList.contains('expanded');

        // 收起其他已展开的项
        document.querySelectorAll('.version-item-wrapper.expanded').forEach(item => {
            if (item !== wrapper) {
                item.classList.remove('expanded');
            }
        });

        // 切换当前项
        wrapper.classList.toggle('expanded', !isExpanded);
    }

    /**
     * 获取日期键（YYYY-MM-DD）
     */
    getDateKey(timeStr) {
        const date = new Date(timeStr);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    /**
     * 按日期分组构建
     */
    groupByDate(builds) {
        const groups = {};
        builds.forEach(build => {
            const key = this.getDateKey(build.time);
            if (!groups[key]) groups[key] = [];
            groups[key].push(build);
        });
        return groups;
    }

    /**
     * 格式化分组日期标题
     * 格式：今日（周日 1月12日）、昨日（周六 1月11日）、周五 1月10日
     */
    formatDateGroupTitle(dateKey) {
        const [year, month, day] = dateKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        // 获取周几
        const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const weekday = weekdays[date.getDay()];

        const dateStr = `${month}月${day}日`;

        if (this.isSameDay(date, today)) {
            return `今日（${weekday} ${dateStr}）`;
        } else if (this.isSameDay(date, yesterday)) {
            return `昨日（${weekday} ${dateStr}）`;
        } else {
            return `${weekday} ${dateStr}`;
        }
    }

    /**
     * 判断两个日期是否同一天
     */
    isSameDay(d1, d2) {
        return d1.getFullYear() === d2.getFullYear() &&
            d1.getMonth() === d2.getMonth() &&
            d1.getDate() === d2.getDate();
    }

    /**
     * 格式化构建时间（5分钟前(20:15:07)）
     */
    formatBuildTime(timeStr) {
        const date = new Date(timeStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHour = Math.floor(diffMs / 3600000);

        let relative;
        if (diffMin < 1) {
            relative = '刚刚';
        } else if (diffMin < 60) {
            relative = `${diffMin}分钟前`;
        } else if (diffHour < 24) {
            relative = `${diffHour}小时前`;
        } else {
            relative = `${Math.floor(diffHour / 24)}天前`;
        }

        const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
        return `${relative}（${time}）`;
    }

    /**
     * 直接安装或下载
     */
    installOrDownload(build, platform) {
        if (platform === 'ios') {
            const ios = build.platforms.ios;
            const installUrl = this.getIosInstallUrl(ios);
            window.location.href = installUrl;
        } else if (platform === 'android') {
            const android = build.platforms.android;
            const downloadUrl = `${this.config.publicBaseUrl}/download/${android.apk}`;
            window.location.href = downloadUrl;
        }
    }

    /**
     * 处理 hash 变化
     * 支持的 URL 格式：
     * - #build=ios_dev_0.7.0_390 - 显示指定构建
     * - #platform=ios - 筛选平台
     * - #platform=ios&branch=dev - 筛选平台和分支
     */
    handleHashChange() {
        const hash = window.location.hash.slice(1); // 移除 #
        const params = new URLSearchParams(hash);

        const buildId = params.get('build');
        const platform = params.get('platform');
        const branch = params.get('branch');

        if (buildId) {
            // 显示指定构建详情
            const build = this.builds.find(b => b.id === buildId || b.dir === buildId);

            // 获取指定的平台（如果有）
            const focusPlatform = params.get('platform');

            if (build) {
                // 更新版本列表选中状态
                this.updateVersionListSelection(build.dir);

                // 始终显示详情面板
                this.showSelectedDetail(build, focusPlatform);
            } else {
                // 构建不在列表中，需要单独加载
                this.loadBuildDetail(buildId, focusPlatform);
            }
        } else if (platform || branch) {
            // 应用筛选（更新分支选择器）
            if (branch && this.els.branchFilter) {
                this.els.branchFilter.value = branch;
            }
            // 重新加载数据
            this.loadBuilds(false, { platform, branch });
        } else {
            // 无参数时隐藏详情卡片，清除选中状态
            this.hideSelectedDetail();
        }
    }

    /**
     * 更新版本列表的选中状态
     */
    updateVersionListSelection(buildDir) {
        // 清除所有选中状态
        document.querySelectorAll('.version-item.active').forEach(item => {
            item.classList.remove('active');
        });
        // 设置新的选中状态
        document.querySelectorAll(`.version-item[data-dir="${buildDir}"]`).forEach(item => {
            item.classList.add('active');
        });
    }

    /**
     * 加载单个构建详情
     */
    async loadBuildDetail(buildDir, focusPlatform = null) {
        try {
            const res = await fetch(`/api/builds/${buildDir}`);
            const data = await res.json();

            if (data.success) {
                // 显示详情卡片
                this.showSelectedDetail(data.data, focusPlatform);
            }
        } catch (err) {
            console.error('加载构建详情失败:', err);
        }
    }

    /**
     * 显示选中版本的详情卡片
     */
    showSelectedDetail(build, focusPlatform = null) {
        if (!this.els.selectedDetail || !this.els.selectedDetailContent) return;

        // 更新列表选中状态
        this.updateVersionListSelection(build.dir);

        const ios = build.platforms?.ios;
        const android = build.platforms?.android;

        let content = '';

        // iOS 部分（如果指定了 focusPlatform，只显示该平台）
        if (ios?.available && (!focusPlatform || focusPlatform === 'ios')) {
            const installUrl = this.getIosInstallUrl(ios);

            content += `
                <div class="detail-platform-section">
                    <div class="detail-platform-header">
                        <span class="detail-platform-name">iOS</span>
                    </div>
                    <div class="detail-platform-info">
                        <div class="detail-info-row">
                            <span class="detail-info-label">版本</span>
                            <span class="detail-info-value">${ios.version} (${ios.build})</span>
                        </div>
                        <div class="detail-info-row">
                            <span class="detail-info-label">分支</span>
                            <span class="detail-info-value">${ios.branch || '-'}</span>
                        </div>
                        <div class="detail-info-row">
                            <span class="detail-info-label">推送环境</span>
                            <span class="detail-info-value">${this.renderEnvBadge(ios.env)} ${ios.env || 'unknown'}</span>
                        </div>
                        <div class="detail-info-row">
                            <span class="detail-info-label">大小</span>
                            <span class="detail-info-value">${ios.size || '-'}</span>
                        </div>
                    </div>
                    <div class="detail-qr-container">
                        <img class="detail-qr-code" src="/qr?text=${encodeURIComponent(installUrl)}&size=200" alt="iOS 安装二维码">
                    </div>
                    <div class="detail-actions">
                        <button class="btn btn-primary detail-install-btn" data-url="${installUrl}">
                            点击安装
                        </button>
                        <button class="btn-link detail-copy-btn" data-url="${installUrl}">
                            复制安装链接
                        </button>
                    </div>
                </div>
            `;
        }

        // Android 部分
        if (android?.available && (!focusPlatform || focusPlatform === 'android')) {
            const downloadUrl = `${this.config.publicBaseUrl}/download/${android.apk}`;
            const mappingUrl = this.getMappingUrl(android);

            content += `
                <div class="detail-platform-section">
                    <div class="detail-platform-header">
                        <span class="detail-platform-name">Android</span>
                    </div>
                    <div class="detail-platform-info">
                        <div class="detail-info-row">
                            <span class="detail-info-label">版本</span>
                            <span class="detail-info-value">${android.version} (${android.build})</span>
                        </div>
                        <div class="detail-info-row">
                            <span class="detail-info-label">分支</span>
                            <span class="detail-info-value">${android.branch || '-'}</span>
                        </div>
                        <div class="detail-info-row">
                            <span class="detail-info-label">大小</span>
                            <span class="detail-info-value">${android.size || '-'}</span>
                        </div>
                    </div>
                    <div class="detail-qr-container">
                        <img class="detail-qr-code" src="/qr?text=${encodeURIComponent(downloadUrl)}&size=200" alt="Android 下载二维码">
                    </div>
                    <div class="detail-actions">
                        <a href="${downloadUrl}" class="btn btn-primary detail-download-btn" download>
                            下载 APK
                        </a>
                        <div class="detail-link-actions">
                            <button class="btn-link detail-copy-btn" data-url="${downloadUrl}">
                                复制下载链接
                            </button>
                            ${mappingUrl
                    ? `<a href="${mappingUrl}" class="btn-link detail-mapping-btn" download>下载 mapping${android.mappingSize ? ` (${android.mappingSize})` : ''}</a>`
                    : ''
                }
                        </div>
                    </div>
                </div>
            `;
        }

        this.els.selectedDetailContent.innerHTML = content;
        this.els.selectedDetail.hidden = false;

        // 绑定详情面板内的事件
        this.bindDetailEvents();

        // 滚动到详情卡片
        setTimeout(() => {
            this.els.selectedDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    }

    /**
     * 绑定详情面板内的按钮事件
     */
    bindDetailEvents() {
        // iOS 安装按钮
        this.els.selectedDetailContent.querySelectorAll('.detail-install-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                if (url) {
                    window.location.href = url;
                }
            });
        });

        // 复制链接按钮
        this.els.selectedDetailContent.querySelectorAll('.detail-copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.dataset.url;
                if (url) {
                    this.copyToClipboard(url);
                }
            });
        });
    }

    /**
     * 隐藏选中版本的详情卡片
     */
    hideSelectedDetail() {
        if (this.els.selectedDetail) {
            this.els.selectedDetail.hidden = true;
        }
        // 清除列表选中状态
        document.querySelectorAll('.version-item.active').forEach(item => {
            item.classList.remove('active');
        });
    }

    /**
     * iOS 安装
     */
    installIOS() {
        const url = this.els.iosCopyBtn.dataset.url;
        if (url) {
            window.location.href = url;
        }
    }

    /**
     * 复制到剪贴板
     */
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            this.showToast('已复制到剪贴板');
        } catch (err) {
            // Fallback
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            this.showToast('已复制到剪贴板');
        }
    }

    /**
     * 显示 Toast
     */
    showToast(message) {
        this.els.toast.querySelector('.toast-text').textContent = message;
        this.els.toast.hidden = false;
        this.els.toast.classList.remove('hide');

        setTimeout(() => {
            this.els.toast.classList.add('hide');
            setTimeout(() => {
                this.els.toast.hidden = true;
            }, 300);
        }, 2000);
    }

    /**
     * 更新应用图标
     * 优先级：全局配置 → 默认 📦
     * @param {object} build - 构建对象
     */
    async updateAppIcon(build) {
        // 使用全局配置的图标
        if (this.config && this.config.appIcon) {
            this._setAppIconImage(this.config.appIcon);
            return;
        }

        // 默认 📦
        this.els.appIcon.innerHTML = '📦';
    }

    /**
     * 设置应用图标为图片
     * @param {string} src - 图片 URL
     */
    _setAppIconImage(src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = this.config?.appName || '应用图标';
        img.className = 'app-icon-img';
        img.onerror = () => {
            // 加载失败时回退到默认图标
            this.els.appIcon.innerHTML = '📦';
        };
        this.els.appIcon.innerHTML = '';
        this.els.appIcon.appendChild(img);
    }

    /**
     * 格式化时间 - 返回 HTML 字符串
     * 格式：相对时间 + (详细时间)
     * @param {string} isoString - ISO 时间字符串
     * @param {boolean} showDetail - 是否显示详细时间（默认 true）
     */
    formatTime(isoString, showDetail = true) {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        // 相对时间
        let relativeTime;
        if (diffMin < 1) {
            relativeTime = '刚刚';
        } else if (diffMin < 60) {
            relativeTime = `${diffMin}分钟前`;
        } else if (diffHour < 24) {
            relativeTime = `${diffHour}小时前`;
        } else {
            relativeTime = `${diffDay}天前`;
        }

        if (!showDetail) {
            return relativeTime;
        }

        // 详细时间格式：YYYY年M月D日HH:mm:ss
        const detailTime = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;

        return `${relativeTime} <span class="time-detail">(${detailTime})</span>`;
    }

    // ========================================
    // 包体积统计功能
    // ========================================

    /**
     * 切换"所有构建"卡片展开/折叠（仅移动端）
     */
    toggleHistoryPanel() {
        if (!this.els.history) return;

        // 仅移动端有效
        const platform = this.detectPlatform();
        const isMobile = platform === 'ios' || platform === 'android';
        if (!isMobile) return;

        this.els.history.classList.toggle('collapsed');
    }

    /**
     * 切换统计面板展开/折叠
     */
    async toggleStatsPanel() {
        if (!this.els.statsPanel) return;

        const isCollapsed = this.els.statsPanel.classList.contains('collapsed');

        if (isCollapsed) {
            // 展开面板
            this.els.statsPanel.classList.remove('collapsed');

            // 检测设备类型
            const platform = this.detectPlatform();
            const isMobile = platform === 'ios' || platform === 'android';

            if (isMobile) {
                // 移动端：显示平台切换标签
                if (this.els.statsPlatformTabs) {
                    this.els.statsPlatformTabs.hidden = false;
                }
                // 默认显示当前设备平台
                this.mobileStatsPlatform = platform;
                this.els.statsPlatformTabs?.querySelectorAll('.platform-tab').forEach(tab => {
                    tab.classList.toggle('active', tab.dataset.platform === platform);
                });
                this.els.statsCharts?.classList.add(`show-${platform}`);
            } else {
                // 桌面端：隐藏平台切换标签，双列显示
                if (this.els.statsPlatformTabs) {
                    this.els.statsPlatformTabs.hidden = true;
                }
                this.els.statsCharts?.classList.remove('show-ios', 'show-android');
            }

            // 如果还没加载过数据，则加载
            if (!this.statsLoaded) {
                await this.loadAndRenderStats();
                this.statsLoaded = true;
            }
        } else {
            // 折叠面板
            this.els.statsPanel.classList.add('collapsed');
        }
    }

    /**
     * 加载并渲染统计数据
     */
    async loadAndRenderStats() {
        try {
            const res = await fetch('/api/stats/size?limit=30');
            const data = await res.json();

            if (!data.success) {
                console.error('加载统计数据失败:', data.error);
                return;
            }

            const stats = data.data;

            // 渲染 iOS 图表
            if (stats.ios) {
                this.renderSizeChart('ios', stats.ios);
            } else {
                this.showNoDataMessage('ios');
            }

            // 渲染 Android 图表
            if (stats.android) {
                this.renderSizeChart('android', stats.android);
            } else {
                this.showNoDataMessage('android');
            }
        } catch (err) {
            console.error('加载统计数据失败:', err);
        }
    }

    /**
     * 渲染包体积图表
     */
    renderSizeChart(platform, stats) {
        const canvasId = `${platform}-size-chart`;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        // 销毁旧图表
        if (platform === 'ios' && this.iosChart) {
            this.iosChart.destroy();
        } else if (platform === 'android' && this.androidChart) {
            this.androidChart.destroy();
        }

        // 准备数据
        const labels = stats.data.map(d => d.version);
        const sizes = stats.data.map(d => d.size / 1024 / 1024); // 转换为 MB

        // 获取主题色
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
            (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);

        const lineColor = platform === 'ios' ? '#007AFF' : '#3DDC84';
        const textColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)';
        const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

        // 创建图表
        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: '包大小 (MB)',
                    data: sizes,
                    borderColor: lineColor,
                    backgroundColor: `${lineColor}20`,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        display: false,
                    },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const item = stats.data[ctx.dataIndex];
                                return `${item.sizeFormatted}`;
                            },
                            afterLabel: (ctx) => {
                                const item = stats.data[ctx.dataIndex];
                                return `分支: ${item.branch || 'dev'}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            color: textColor,
                            maxRotation: 45,
                            minRotation: 0,
                        },
                        grid: {
                            color: gridColor,
                        }
                    },
                    y: {
                        beginAtZero: false,
                        ticks: {
                            color: textColor,
                            callback: (value) => `${value.toFixed(1)} MB`,
                        },
                        grid: {
                            color: gridColor,
                        }
                    }
                }
            }
        });

        // 保存图表实例
        if (platform === 'ios') {
            this.iosChart = chart;
        } else {
            this.androidChart = chart;
        }

        // 渲染统计摘要
        this.renderChartSummary(platform, stats.summary);
    }

    /**
     * 渲染统计摘要
     */
    renderChartSummary(platform, summary) {
        const container = document.getElementById(`${platform}-chart-summary`);
        if (!container) return;

        let trendHtml = '';
        if (summary.trend) {
            const trendClass = summary.trend.direction === 'increase' ? 'increase' :
                summary.trend.direction === 'decrease' ? 'decrease' : '';
            const trendIcon = summary.trend.direction === 'increase' ? '📈' :
                summary.trend.direction === 'decrease' ? '📉' : '➡️';
            const trendSign = summary.trend.direction === 'increase' ? '+' :
                summary.trend.direction === 'decrease' ? '-' : '';
            trendHtml = `
                <div class="chart-summary-item">
                    <span class="chart-summary-label">趋势</span>
                    <span class="chart-summary-value ${trendClass}">${trendIcon} ${trendSign}${summary.trend.changeFormatted} (${trendSign}${summary.trend.changePercent}%)</span>
                </div>
            `;
        }

        container.innerHTML = `
            <div class="chart-summary-item">
                <span class="chart-summary-label">最新版本</span>
                <span class="chart-summary-value">${summary.latest.sizeFormatted}</span>
            </div>
            <div class="chart-summary-item">
                <span class="chart-summary-label">平均大小</span>
                <span class="chart-summary-value">${summary.avg.sizeFormatted}</span>
            </div>
            <div class="chart-summary-item">
                <span class="chart-summary-label">最小/最大</span>
                <span class="chart-summary-value">${summary.min.sizeFormatted} ~ ${summary.max.sizeFormatted}</span>
            </div>
            ${trendHtml}
        `;
    }

    /**
     * 显示无数据提示
     */
    showNoDataMessage(platform) {
        const container = document.getElementById(`${platform}-chart-container`);
        if (!container) return;

        const canvas = container.querySelector('canvas');
        if (canvas) {
            canvas.style.display = 'none';
        }

        const summary = document.getElementById(`${platform}-chart-summary`);
        if (summary) {
            summary.innerHTML = '<div class="chart-no-data">暂无包体积数据</div>';
        }
    }
}

// 启动应用
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ArtifactPortal();
    window.app.init();
});
