# Artifact Portal

IPA / APK 构建分发服务 —— 面向测试和产品人员的极简安装页面。

## ✨ 功能特性

- 📱 **一键安装**：扫码即可安装 iOS / Android 应用
- 📋 **一键复制**：复制安装链接，方便分享到群聊
- 📝 **更新日志**：AI 智能总结 + 原始 commit 列表
- 🌙 **深色模式**：跟随系统 + 手动切换
- 🔗 **固定链接**：`/latest` 永远指向最新构建
- 📊 **历史版本**：查看和安装历史构建
- 🔍 **分支筛选**：按分支过滤构建列表

## 🚀 快速开始

### 1. 安装依赖

```bash
cd artifact-portal
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件
```

### 3. 启动服务

```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm start
```

### 4. 访问页面

打开 http://localhost:8088（或配置的端口）

## 📁 项目结构

```
artifact-portal/
├── src/
│   ├── server/           # 后端代码
│   │   ├── index.js      # 入口文件
│   │   ├── config.js     # 配置管理
│   │   ├── artifacts.js  # 构建管理
│   │   ├── routes.js     # API 路由
│   │   └── utils/        # 工具函数
│   └── web/              # 前端代码
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── scripts/              # 脚本工具
│   └── cleanup-builds.sh # 构建清理
├── deploy/               # 部署配置
├── deploy.local.example  # 部署配置模板
└── deploy.sh             # 部署脚本
```

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8088` | HTTP 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PUBLIC_BASE_URL` | 自动检测 | 公网访问地址（用于页面访问和 IPA 下载） |
| `BUILDS_DIR` | `./builds` | 构建目录路径 |
| `APP_NAME` | `构建中心` | 页面标题 |
| `APP_ICON` | - | 应用图标路径 |
| `IOS_PLIST_PROXY_URL` | - | iOS plist 代理服务 URL（见下文） |
| `IOS_PLIST_LOGO` | - | iOS 安装时显示的图标 URL（用于 plist 代理） |
| `IOS_DISPLAY_NAME` | - | iOS 应用显示名称（fallback，优先从 Info.plist 解析） |
| `MAX_BUILDS` | `50` | 保留的最大构建数 |
| `MAX_AGE_DAYS` | `30` | 保留的最大天数 |
| `DISK_THRESHOLD_GB` | `50` | 磁盘使用告警阈值 |

## 🔗 API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | 主页面 |
| `GET /latest` | 跳转到最新构建 |
| `GET /latest?platform=ios` | 跳转到最新 iOS 构建 |
| `GET /latest?branch=main` | 跳转到指定分支的最新构建 |
| `GET /api/builds` | 获取构建列表 |
| `GET /api/builds/latest` | 获取最新构建详情 |
| `GET /api/health` | 健康检查 |
| `GET /qr?text=...` | 生成二维码 |
| `GET /download/:dir/:file` | 下载构建文件 |

## 📱 iOS 安装说明

iOS 应用安装（OTA）的 manifest.plist 文件**必须通过受信任的 HTTPS 证书提供**。本服务通过 plist 代理服务解决此问题。

### 配置 plist 代理服务

如果你有一个带有正式 SSL 证书的公网服务可以生成 manifest.plist，可以配置为代理服务：

```env
# plist 代理服务 URL
IOS_PLIST_PROXY_URL=https://your-proxy.example.com/plist

# 公网访问地址（代理服务会使用此地址构建 IPA 下载链接）
PUBLIC_BASE_URL=http://192.168.1.100:8088

# iOS 安装时显示的图标（可选）
IOS_PLIST_LOGO=https://your-cdn.com/logo.png

# iOS 应用显示名称（可选，优先从 Info.plist 解析）
IOS_DISPLAY_NAME=MyApp
```

**代理服务参数**：
- `host` - 下载主机地址（从 PUBLIC_BASE_URL 提取）
- `downloadPath` - IPA 下载路径
- `bundleId` - 应用包名（从 Info.plist 解析）
- `appName` - 应用名称（从 Info.plist 解析）
- `logo` - 安装时显示的图标 URL（可选）

**工作原理**：
1. 前端生成安装链接时，使用代理服务 URL
2. iOS 设备访问代理服务获取 manifest（代理服务有受信任的 HTTPS 证书）
3. iOS 从 manifest 中的 URL 下载 IPA（从 PUBLIC_BASE_URL 下载，HTTP）
4. 安装完成

**优势**：
- iOS 设备无需信任自签名证书即可安装应用
- 本服务只需提供 HTTP 服务，简化部署

### manifest.plist

每个构建目录需要包含 `manifest.plist` 文件，格式如下：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>https://your-domain.com/download/BUILD_DIR/app.ipa</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>com.your.app</string>
        <key>bundle-version</key>
        <string>1.0.0</string>
        <key>title</key>
        <string>Your App</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
```

## 🛠 部署

### 使用 systemd

```bash
# 复制服务文件
sudo cp deploy/artifact-portal.service /etc/systemd/system/

# 重载 systemd
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start artifact-portal

# 开机自启
sudo systemctl enable artifact-portal

# 查看状态
sudo systemctl status artifact-portal
```

## 🧹 构建清理

使用清理脚本定期删除旧构建：

```bash
# 模拟运行（不实际删除）
DRY_RUN=true ./scripts/cleanup-builds.sh

# 实际清理
./scripts/cleanup-builds.sh
```

配置 cron 定时执行：

```bash
# 每天凌晨 3 点执行清理
0 3 * * * /opt/artifact-portal/scripts/cleanup-builds.sh >> /var/log/artifact-cleanup.log 2>&1
```

## 📝 构建目录结构

每个构建目录需要遵循以下结构：

```
20260110_456_abc1234/
├── build.json          # 必需：构建元信息
├── manifest.plist      # iOS 安装清单
├── app.ipa            # iOS 安装包
└── app.apk            # Android 安装包
```

### build.json 格式

```json
{
  "appId": "myapp",
  "displayName": "MyApp",
  "version": "1.3.0",
  "build": "456",
  "time": "2026-01-10T18:22:00+08:00",
  "branch": "main",
  "commit": "abc1234",
  "platforms": {
    "ios": {
      "bundleId": "com.example.app",
      "ipa": "app.ipa",
      "manifest": "manifest.plist"
    },
    "android": {
      "apk": "app.apk"
    }
  },
  "releaseNotes": {
    "summary": ["更新说明1", "更新说明2"],
    "commits": ["feat: ...", "fix: ..."]
  }
}
```

## ❓ 常见问题

### iOS 安装失败

1. 确认 `PUBLIC_BASE_URL` 是 HTTPS
2. 确认 SSL 证书有效
3. 检查 `manifest.plist` 中的 URL 是否正确
4. 确认设备已信任企业证书

### 页面显示空白

1. 检查 `BUILDS_DIR` 路径是否正确
2. 确认构建目录中有 `build.json` 文件
3. 查看服务器日志排查错误

### 二维码无法扫描

1. 检查网络是否可达公网地址
2. 确认 `PUBLIC_BASE_URL` 配置正确
3. 尝试增大二维码尺寸

## 📄 License

MIT
