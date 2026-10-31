package com.q.claudebridge;

import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;

/**
 * TLS с пиннингом самоподписанного сертификата моста.
 * Доверие — только сертификату с отпечатком, полученным вне сети (из QR при сопряжении, P-7).
 * Без отпечатка (fpHex == null или пустой) не доверяем никому — TOFU нет нигде (H-2, L-17).
 */
public final class Tls {

    public static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest(data)) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static String fingerprint(java.security.cert.Certificate cert) {
        try {
            return sha256Hex(cert.getEncoded());
        } catch (Exception e) {
            return "";
        }
    }

    /** Доверяем только сертификату с данным отпечатком; без отпечатка — никому (fail closed, L-17). */
    public static X509TrustManager pinnedTrust(String fpHex) {
        return new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] c, String a) { }
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            @Override
            public void checkServerTrusted(X509Certificate[] chain, String a) throws CertificateException {
                if (fpHex == null || fpHex.isEmpty()) {
                    throw new CertificateException("Отпечаток сертификата моста неизвестен — соединение запрещено");
                }
                if (chain == null || chain.length == 0) {
                    throw new CertificateException("Мост не предъявил сертификат");
                }
                try {
                    if (!fingerprint(chain[0]).equalsIgnoreCase(fpHex)) {
                        throw new CertificateException("Отпечаток сертификата моста не совпадает");
                    }
                } catch (CertificateException e) {
                    throw e;
                } catch (Exception e) {
                    throw new CertificateException(e);
                }
            }
        };
    }

    /** Фабрика сырых TLS-сокетов с тем же пиннингом (для локального WS-прокси). */
    public static javax.net.ssl.SSLSocketFactory socketFactory(String fpHex) {
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{pinnedTrust(fpHex)}, null);
            return ctx.getSocketFactory();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    public static OkHttpClient buildClient(String fpHex) {
        try {
            X509TrustManager tm = pinnedTrust(fpHex);
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[]{tm}, null);
            return new OkHttpClient.Builder()
                    .sslSocketFactory(ctx.getSocketFactory(), tm)
                    .hostnameVerifier((h, s) -> true) // доверие определяет пиннинг, не имя хоста
                    .pingInterval(20, TimeUnit.SECONDS)
                    .connectTimeout(5, TimeUnit.SECONDS)
                    .build();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private Tls() { }
}
