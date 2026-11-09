# Mırıl — Kurulum (bir kere, ~15 dk)

Giriş ekranı yok. Kitaplar senin Drive klasöründen çalınır; profiller ve "kaldığın yer"
senin hesabındaki küçük bir Apps Script'te tutulur. PC ↔ telefon böyle eşitlenir.

## 1. Drive klasörü
Drive'da bir klasör aç (örn. **Sesli Kitaplar**). Her kitap bir alt klasör:

```
Sesli Kitaplar/
  Sabahattin Ali - Kürk Mantolu Madonna/
    01.mp3
    02.mp3
    kapak.jpg          ← isteğe bağlı
  Tek Dosyalık Kitap.m4b
```
- "Yazar - Kitap" adı verirsen yazar ayrı görünür.
- Dosyalar ada göre sıralanır (01, 02 … 10 doğru sıralanır). CD1/CD2 iç klasörleri de olur.
- Desteklenen: mp3, m4a, m4b, aac, ogg, opus, flac, wav.

**Paylaş → Genel erişim → "Bağlantıya sahip olan herkes" → Görüntüleyici.**
Alt klasörler ve sonradan eklediğin dosyalar bu ayarı otomatik alır.
Linki kimseyle paylaşmadığın sürece kimse bulamaz.

## 2. API anahtarı (Google Cloud)
1. https://console.cloud.google.com → yeni proje (örn. "Miril").
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **Credentials → Create credentials → API key.**
4. Anahtarı düzenle (Edit API key):
   - Application restrictions: **Websites** → `https://KULLANICIADIN.github.io/*`
   - API restrictions: **Restrict key** → sadece **Google Drive API**
5. Anahtarı `config.js` içindeki `API_KEY` satırına yapıştır.

OAuth / izin ekranı ayarı gerekmiyor.

## 3. Senkron (Apps Script)
1. https://script.new aç (kendi Google hesabınla).
2. `apps-script.gs` dosyasının tamamını yapıştır.
3. En üstteki `ANAHTAR` değerini kendine özel bir şeyle değiştir (örn. `kedi-mavi-4821-q7x`).
4. **Dağıt → Yeni dağıtım** → dişli → **Web uygulaması**
   - Şu kullanıcı olarak yürüt: **Ben**
   - Erişimi olanlar: **Herkes**
   - İlk seferde Google izin ister → hesabını seç → Gelişmiş → devam → İzin ver.
5. Çıkan adresin sonuna `?k=ANAHTARIN` ekle:
   `https://script.google.com/macros/s/AKfy…/exec?k=kedi-mavi-4821-q7x`

## 4. GitHub Pages
1. GitHub'da yeni repo (örn. `miril`, public).
2. Bu klasördeki dosyaları yükle (`apps-script.gs` ve bu dosya şart değil).
3. Settings → Pages → Branch: `main` / root → Save.
4. Adres: `https://KULLANICIADIN.github.io/miril/`

## 5. İlk açılış
1. Siteyi PC'de aç → **Kurulumu yap**.
2. Klasör linkini ve senkron adresini yapıştır → **Kaydet ve dene**.
3. Profilini oluştur.
4. ⚙︎ Ayarlar → **Kurulum linkini paylaş** → WhatsApp'tan Evren'e ve kendi telefonuna gönder.
   Linki açtığı an kurulur, hiçbir şey yazmaya gerek yok.
5. Telefonda Chrome → ⋮ → **Ana ekrana ekle**. Uygulama gibi açılır, kilit ekranından kontrol edilir.

## Güncellemeler
Yeni sürümü GitHub'a yüklemen yeterli. APK yok; iki cihaza da kendiliğinden gelir
(GitHub önbelleği yüzünden en fazla ~10 dk gecikebilir). Ayarlar ve ilerleme kaybolmaz.

Apps Script kodunu değiştirirsen: Dağıt → Dağıtımları yönet → kalem → Sürüm: **Yeni sürüm**
(adres aynı kalır).

## İndirme (internetsiz dinleme)
- Oynatıcıda **İndir** → kitap bu cihaza iner. Kitaplıkta "İndirilenler" filtresinde görünür.
- İndirilen kitap internet yokken de çalar; uygulama da internetsiz açılır (en az bir kere internetle açılmış olmalı).
- Silmek için: oynatıcıda **İndirildi** → "Bu cihazdan sil", ya da ⚙︎ Ayarlar → "Bu cihazdaki indirilenler".
  Drive'daki asıl dosyalar silinmez.
- **Cihaza da kaydet:** indirilmiş kitabı telefonun/PC'nin İndirilenler klasörüne dosya olarak kopyalar
  (`Miril - Kitap - 01.mp3`). Bu kopyalar uygulamadan bağımsızdır; uygulama onları göremez/silemez.
  Çok bölümlü kitapta Chrome bir kere "birden fazla dosya indirilsin mi?" diye sorabilir → İzin ver.
- İndirme sürerken uygulamayı kapatma (ekranı kilitlemek sorun değil). Yarıda kalırsa "Devam et" kaldığı bölümden sürdürür.

## Notlar
- Klasör linki ve senkron adresi repoda değil, sadece cihazların ayarlarında durur.
  Repoda sadece API anahtarı var; o da sadece senin sitende ve sadece Drive için çalışır.
- Senkron kayıtları senin Drive'ında `miril-sync.json` dosyasında.
- Kaydetme: duraklatınca, bölüm değişince, uygulamayı kapatınca/arka plana alınca ve çalarken dakikada bir.
  İnternet yoksa cihazda bekler, bağlanınca gönderir.
- Çok büyük ve çok sık indirilen herkese açık dosyalarda Google indirme kotası uyarısı verebiliyor;
  iki kişilik kullanımda beklemiyorum ama olursa söyle.
- iPhone/Safari'de test edilmedi; Android Chrome ve masaüstü Chrome/Edge hedeflendi.
