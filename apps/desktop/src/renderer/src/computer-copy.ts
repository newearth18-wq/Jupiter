import type { Language } from '@jupiter/contracts';

const copy = {
  en: {
    eyebrow: 'Windows Computer Agent',
    title: 'Semantic Windows automation',
    description:
      'Jupiter uses Windows UI Automation and application APIs in an isolated process. Coordinates require separate critical approval.',
    operational: 'Operational',
    loading: 'Loading',
    unavailable: 'Unavailable',
    processBoundary: 'Dedicated process',
    adapters: 'Available adapters',
    typedActions: 'typed actions',
    demo: 'Verified Notepad demonstration',
    demoDescription:
      'Open real Notepad, type the exact text, save to the approved path, verify the content, and close Notepad.',
    exactText: 'Exact text',
    outputPath: 'Exact output path',
    run: 'Run real demonstration',
    retry: 'Retry after approval',
    cancel: 'Cancel safely',
    refresh: 'Refresh',
    waitingPermission: 'Explicit permission is required. Review Permission Center, then retry.',
    running: 'Working in the isolated Windows automation process…',
    history: 'Verified action history',
    noHistory: 'No Windows action has run yet.',
    evidence: 'Verified artifact',
    failed: 'The real Windows action failed.',
    loadFailed: 'Computer Agent data could not be loaded.',
    fallbackPolicy: 'Coordinate fallback: explicit CRITICAL permission only',
  },
  th: {
    eyebrow: 'Windows Computer Agent',
    title: 'ระบบควบคุม Windows แบบ Semantic',
    description:
      'Jupiter ใช้ Windows UI Automation และ API ของแอปในโพรเซสแยก การใช้พิกัดต้องได้รับอนุญาตระดับวิกฤตต่างหาก',
    operational: 'พร้อมใช้งาน',
    loading: 'กำลังโหลด',
    unavailable: 'ไม่พร้อมใช้งาน',
    processBoundary: 'โพรเซสแยกเฉพาะ',
    adapters: 'อะแดปเตอร์ที่พร้อมใช้',
    typedActions: 'การทำงานแบบมีชนิดข้อมูล',
    demo: 'การสาธิต Notepad แบบตรวจสอบผลจริง',
    demoDescription:
      'เปิด Notepad จริง พิมพ์ข้อความที่ระบุ บันทึกไปยังตำแหน่งที่อนุมัติ ตรวจเนื้อหา และปิด Notepad',
    exactText: 'ข้อความที่ต้องพิมพ์',
    outputPath: 'ตำแหน่งไฟล์ที่แน่นอน',
    run: 'เริ่มการสาธิตจริง',
    retry: 'ลองอีกครั้งหลังอนุมัติ',
    cancel: 'ยกเลิกอย่างปลอดภัย',
    refresh: 'รีเฟรช',
    waitingPermission: 'ต้องยืนยันสิทธิ์ก่อน โปรดตรวจ Permission Center แล้วลองอีกครั้ง',
    running: 'กำลังทำงานในโพรเซส Windows Automation ที่แยกออกมา…',
    history: 'ประวัติการทำงานที่ตรวจสอบได้',
    noHistory: 'ยังไม่มีการทำงานบน Windows',
    evidence: 'อาร์ติแฟกต์ที่ตรวจสอบแล้ว',
    failed: 'การทำงานบน Windows จริงล้มเหลว',
    loadFailed: 'ไม่สามารถโหลดข้อมูล Computer Agent ได้',
    fallbackPolicy: 'การใช้พิกัด: ต้องอนุมัติระดับ CRITICAL โดยเฉพาะเท่านั้น',
  },
} as const;

export function computerCopy(language: Language) {
  return copy[language];
}
