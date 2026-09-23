// build/fuses.js — electron-builder afterPack 钩子:翻 Electron fuses,把"签名壳 = 承诺锚"焊死。
//
// 每一项都对应一条绕过出域闸的路,翻掉之后这条路在正式包里不存在:
//   RunAsNode=false                          ELECTRON_RUN_AS_NODE 把壳当 node 跑 → 关
//   EnableNodeOptionsEnvironmentVariable=false NODE_OPTIONS 注入 --require 脚本 → 关
//   EnableNodeCliInspectArguments=false        --inspect 挂调试器读主进程内存 → 关
//   EnableEmbeddedAsarIntegrityValidation=true 改 app.asar(换掉 main.js)启动即拒 → 开
//   OnlyLoadAppFromAsar=true                   旁边放个 app/ 目录顶掉 asar → 关
//   EnableCookieEncryption=true                会话 cookie 落盘加密 → 开
//
// 注意顺序:afterPack 在签名之前跑,所以翻完 fuses 再签名,签名覆盖的是翻完的二进制。
// macOS arm64 翻 fuses 会破坏 ad-hoc 签名,resetAdHocDarwinSignature 先补一个临时的,后面正式签名再覆盖。
const path = require('path')
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context
  const productFilename = packager.appInfo.productFilename
  let electronBinary
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    electronBinary = path.join(appOutDir, `${productFilename}.app`)
  } else if (electronPlatformName === 'win32') {
    electronBinary = path.join(appOutDir, `${productFilename}.exe`)
  } else {
    electronBinary = path.join(appOutDir, productFilename)
  }

  await flipFuses(electronBinary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })
  console.log(`[fuses] flipped on ${electronBinary}`)
}
