# CHKSZ Music App

## 方式一：GitHub Actions（推荐）

1. Fork 本仓库
2. 进入你的仓库 → Actions → Build APK → Run workflow
3. 等待构建完成，从 Artifacts 下载 APK

## 方式二：本地构建

### 环境要求

- Node.js 18+（推荐 20 LTS）
- Java JDK 21（Android Gradle 8.13 要求）
- Android SDK

### 快速开始

```bash
# 1. 克隆
git clone https://github.com/your-username/chksz-app.git
cd chksz-app

# 2. 安装依赖
npm install

# 3. 设置环境变量（按你的实际路径修改）
# Windows PowerShell
$env:JAVA_HOME="你的JDK21路径"
$env:ANDROID_HOME="你的Android SDK路径"

# macOS / Linux
export JAVA_HOME="/你的JDK21路径"
export ANDROID_HOME="/你的Android SDK路径"

# 4. 构建
npm run build
npm run cap:sync
cd android && ./gradlew assembleDebug
```

APK 输出位置：`android/app/build/outputs/apk/debug/app-debug.apk`

### 环境变量说明

**JAVA_HOME** - JDK 21 路径
- 有 Android Studio：通常在 `Android Studio/jbr` 目录
- 无 Android Studio：从 https://adoptium.net/ 下载 JDK 21

**ANDROID_HOME** - Android SDK 路径
- 有 Android Studio：在 Settings → Languages & Frameworks → Android SDK 查看
- 无 Android Studio：从 https://developer.android.com/studio/command-line#tools 下载 Command Line Tools

## 常见问题

**报错 "Dependency requires at least JVM runtime version 11"**
→ JAVA_HOME 未设置或指向旧版 Java，必须使用 JDK 21。

**报错 "SDK location not found"**
→ ANDROID_HOME 未设置，或 android/local.properties 中路径不正确。

**local.properties 报错**
→ 确保 sdk.dir 使用正斜杠：`sdk.dir=C:/dev/Android/Sdk`

## 鸣谢

https://linux.do 社区
