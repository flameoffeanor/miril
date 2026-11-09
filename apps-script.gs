/**
 * Mırıl — senkron sunucusu (Google Apps Script)
 * Profilleri ve "kaldığın yer" bilgisini senin Drive'ında tek bir JSON dosyasında tutar.
 *
 * Kurulum:
 *  1. https://script.new  → bu dosyanın tamamını yapıştır.
 *  2. Aşağıdaki ANAHTAR'ı kendine özel, tahmin edilemeyen bir şeyle değiştir.
 *  3. Dağıt (Deploy) → Yeni dağıtım → Tür: Web uygulaması
 *       Yürütme: Ben (kendi hesabın)
 *       Erişim: Herkes
 *  4. Çıkan ".../exec" adresinin sonuna  ?k=ANAHTAR  ekle → Mırıl ayarlarına yapıştır.
 *  Kodu sonradan değiştirirsen: Dağıtımları yönet → kalem → Sürüm: Yeni sürüm.
 */
const ANAHTAR = 'BURAYI-DEGISTIR-ornek-kedi-4821-x9q';
const DOSYA_ADI = 'miril-sync.json';

function doGet(e) {
  if (!yetkili(e)) return cikti({ error: 'Anahtar yanlış' });
  return cikti({ data: oku() });
}

function doPost(e) {
  if (!yetkili(e)) return cikti({ error: 'Anahtar yanlış' });
  const kilit = LockService.getScriptLock();
  kilit.waitLock(15000);
  try {
    const gelen = JSON.parse(e.postData.contents || '{}');
    const birlesik = birlestir(oku(), gelen);
    yaz(birlesik);
    return cikti({ data: birlesik });
  } catch (err) {
    return cikti({ error: String(err) });
  } finally {
    kilit.releaseLock();
  }
}

function yetkili(e) { return e && e.parameter && e.parameter.k === ANAHTAR; }

function cikti(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function dosya() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('dosyaId');
  if (id) { try { return DriveApp.getFileById(id); } catch (e) {} }
  const f = DriveApp.createFile(DOSYA_ADI, '{}', 'application/json');
  props.setProperty('dosyaId', f.getId());
  return f;
}
function oku() { try { return JSON.parse(dosya().getBlob().getDataAsString() || '{}'); } catch (e) { return {}; } }
function yaz(obj) { dosya().setContent(JSON.stringify(obj)); }

// Uygulamadaki merge() ile aynı mantık: her kayıtta en yeni "at" kazanır.
function yeni(a, b) { return !a ? b : !b ? a : (b.at || 0) > (a.at || 0) ? b : a; }
function birlestir(a, b) {
  const out = { v: 1, profiles: {}, progress: {}, durations: {}, prefs: {} };
  [a, b].forEach(function (src) {
    if (!src) return;
    Object.keys(src.profiles || {}).forEach(function (id) { out.profiles[id] = yeni(out.profiles[id], src.profiles[id]); });
    Object.keys(src.progress || {}).forEach(function (pid) {
      out.progress[pid] = out.progress[pid] || {};
      Object.keys(src.progress[pid]).forEach(function (bid) { out.progress[pid][bid] = yeni(out.progress[pid][bid], src.progress[pid][bid]); });
    });
    Object.assign(out.durations, src.durations || {});
    Object.keys(src.prefs || {}).forEach(function (pid) { out.prefs[pid] = yeni(out.prefs[pid], src.prefs[pid]); });
  });
  return out;
}
