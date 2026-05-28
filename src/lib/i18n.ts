export type Locale = 'en' | 'zh' | 'vi' | 'th' | 'ms' | 'id'
export const LOCALES = [
  { code: 'en' as Locale, label: 'English',    flag: '🇬🇧' },
  { code: 'zh' as Locale, label: '中文',        flag: '🇨🇳' },
  { code: 'vi' as Locale, label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'th' as Locale, label: 'ภาษาไทย',    flag: '🇹🇭' },
  { code: 'ms' as Locale, label: 'Melayu',     flag: '🇲🇾' },
  { code: 'id' as Locale, label: 'Indonesia',  flag: '🇮🇩' },
]
type D = Record<Locale, string>
export const g = (d: D, l: Locale) => d[l] ?? d['en']

export const T = {
  // Login
  loginTitle:    { en:'Sign in to LanWealth',        zh:'登录 LanWealth',           vi:'Đăng nhập LanWealth',      th:'เข้าสู่ระบบ LanWealth',     ms:'Log masuk LanWealth',      id:'Masuk LanWealth'          } as D,
  emailLabel:    { en:'Email',                        zh:'邮箱',                      vi:'Email',                    th:'อีเมล',                       ms:'E-mel',                    id:'Email'                    } as D,
  passLabel:     { en:'Password',                     zh:'密码',                      vi:'Mật khẩu',                 th:'รหัสผ่าน',                    ms:'Kata laluan',              id:'Kata sandi'               } as D,
  loginBtn:      { en:'Sign in →',                    zh:'登录 →',                    vi:'Đăng nhập →',              th:'เข้าสู่ระบบ →',               ms:'Log masuk →',              id:'Masuk →'                  } as D,
  noAccount:     { en:'No account? Open dashboard →', zh:'没有账号？打开控制台 →',    vi:'Chưa có tài khoản? →',     th:'ยังไม่มีบัญชี? →',            ms:'Tiada akaun? →',           id:'Belum punya akun? →'      } as D,
  // Chat header
  newChat:       { en:'New Chat',                     zh:'新对话',                    vi:'Cuộc trò chuyện mới',      th:'แชทใหม่',                      ms:'Sembang Baharu',           id:'Obrolan Baru'             } as D,
  clear:         { en:'Clear',                        zh:'清除',                      vi:'Xóa',                      th:'ล้าง',                         ms:'Kosongkan',                id:'Hapus'                    } as D,
  settings:      { en:'Settings',                     zh:'设置',                      vi:'Cài đặt',                  th:'การตั้งค่า',                   ms:'Tetapan',                  id:'Pengaturan'               } as D,
  signout:       { en:'Sign out',                     zh:'退出登录',                  vi:'Đăng xuất',                th:'ออกจากระบบ',                   ms:'Log keluar',               id:'Keluar'                   } as D,
  // Messages
  noConvs:       { en:'No conversations yet',         zh:'暂无对话',                  vi:'Chưa có cuộc trò chuyện',  th:'ยังไม่มีการสนทนา',             ms:'Belum ada perbualan',      id:'Belum ada percakapan'     } as D,
  welcomeTitle:  { en:'LanWealth AI',                 zh:'LanWealth AI 对话',         vi:'LanWealth AI',             th:'LanWealth AI',                 ms:'LanWealth AI',             id:'LanWealth AI'             } as D,
  poweredBy:     { en:'Powered by',                   zh:'当前模型',                  vi:'Được cung cấp bởi',        th:'ขับเคลื่อนโดย',               ms:'Dikuasakan oleh',          id:'Didukung oleh'            } as D,
  you:           { en:'You',                          zh:'你',                        vi:'Bạn',                      th:'คุณ',                           ms:'Anda',                     id:'Anda'                     } as D,
  copy:          { en:'Copy',                         zh:'复制',                      vi:'Sao chép',                 th:'คัดลอก',                       ms:'Salin',                    id:'Salin'                    } as D,
  copied:        { en:'✓ Copied',                     zh:'✓ 已复制',                  vi:'✓ Đã sao chép',            th:'✓ คัดลอกแล้ว',                 ms:'✓ Disalin',                id:'✓ Tersalin'               } as D,
  topup:         { en:'Top up →',                     zh:'充值 →',                    vi:'Nạp tiền →',               th:'เติมเครดิต →',                 ms:'Tambah kredit →',          id:'Isi ulang →'              } as D,
  send:          { en:'Send',                         zh:'发送',                      vi:'Gửi',                      th:'ส่ง',                           ms:'Hantar',                   id:'Kirim'                    } as D,
  delete:        { en:'Delete',                       zh:'删除',                      vi:'Xóa',                      th:'ลบ',                            ms:'Padam',                    id:'Hapus'                    } as D,
  balance:       { en:'Balance',                      zh:'余额',                      vi:'Số dư',                    th:'ยอดเงิน',                       ms:'Baki',                     id:'Saldo'                    } as D,
}

export const SUGGESTIONS: Record<Locale, string[]> = {
  en: ['Explain quantum entanglement simply','Write a Python web scraper','Review and improve my code','Draft a professional email'],
  zh: ['用简单语言解释量子纠缠','写一个 Python 网页爬虫','帮我检查并优化代码','帮我起草专业邮件'],
  vi: ['Giải thích đơn giản về lượng tử','Viết script Python crawl web','Review code của tôi','Soạn email chuyên nghiệp'],
  th: ['อธิบาย quantum entanglement ง่ายๆ','เขียน Python web scraper','รีวิว code ของฉัน','ร่างอีเมลมืออาชีพ'],
  ms: ['Terangkan quantum entanglement','Tulis Python web scraper','Semak kod saya','Draf e-mel profesional'],
  id: ['Jelaskan quantum entanglement','Tulis Python web scraper','Review kode saya','Buat email profesional'],
}
export const PLACEHOLDER: Record<Locale, string> = {
  en: 'Message {model}…  (Enter ↵ send · Shift+Enter new line)',
  zh: '发消息给 {model}…  (回车发送 · Shift+回车换行)',
  vi: 'Nhắn tin cho {model}…  (Enter gửi · Shift+Enter xuống dòng)',
  th: 'ส่งถึง {model}…  (Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่)',
  ms: 'Hantar ke {model}…  (Enter hantar · Shift+Enter baris baru)',
  id: 'Kirim ke {model}…  (Enter kirim · Shift+Enter baris baru)',
}
