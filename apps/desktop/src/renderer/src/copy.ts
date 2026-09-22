export const copy = {
  en: {
    foundation: 'Repository foundation',
    operational: 'Operational',
    degraded: 'Degraded',
    loading: 'Checking the actual runtime…',
    intro: 'The secure Jupiter desktop shell is running.',
    deferred: 'AI and agent capabilities are Coming later.',
    diagnostics: 'Diagnostics',
    settings: 'Settings',
    home: 'Home',
    retry: 'Retry startup',
    notConfigured: 'Not configured',
    settingsMessage: 'Settings are not configured in SET 0. Configuration begins in a later SET.',
    unavailable: 'Unavailable',
  },
  th: {
    foundation: 'โครงสร้างพื้นฐานของ repository',
    operational: 'ทำงานปกติ',
    degraded: 'ทำงานแบบจำกัด',
    loading: 'กำลังตรวจสถานะ runtime จริง…',
    intro: 'Secure Jupiter desktop shell กำลังทำงาน',
    deferred: 'ความสามารถ AI และ Agent จะพัฒนาใน SET ถัดไป',
    diagnostics: 'การวินิจฉัย',
    settings: 'การตั้งค่า',
    home: 'หน้าหลัก',
    retry: 'ลองเริ่มระบบอีกครั้ง',
    notConfigured: 'ยังไม่ได้กำหนดค่า',
    settingsMessage: 'การตั้งค่ายังไม่พร้อมใน SET 0 และจะเริ่มใน SET ถัดไป',
    unavailable: 'ยังไม่พร้อมใช้งาน',
  },
} as const;

export function getCopy(): (typeof copy)['en'] | (typeof copy)['th'] {
  return navigator.language.toLowerCase().startsWith('th') ? copy.th : copy.en;
}
