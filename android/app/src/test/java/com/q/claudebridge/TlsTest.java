package com.q.claudebridge;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;

import javax.net.ssl.X509TrustManager;

public class TlsTest {

    private static void assertRejects(X509TrustManager tm, X509Certificate[] chain) {
        try {
            tm.checkServerTrusted(chain, "ECDHE_ECDSA");
            fail("сертификат принят");
        } catch (CertificateException expected) {
            // ok
        }
    }

    @Test
    public void withoutPinnedFingerprintEverythingIsRejected() {
        // L-17: TOFU нигде — без отпечатка доверия нет (fail closed)
        X509TrustManager tm = Tls.pinnedTrust(null);
        assertRejects(tm, new X509Certificate[0]);
        assertRejects(tm, null);
        assertRejects(Tls.pinnedTrust(""), new X509Certificate[0]);
    }

    @Test
    public void emptyChainIsRejectedEvenWithPin() {
        assertRejects(Tls.pinnedTrust("00".repeat(32)), new X509Certificate[0]);
        assertRejects(Tls.pinnedTrust("00".repeat(32)), null);
    }

    @Test
    public void clientWithoutPinCanBeBuiltButTrustsNothing() {
        // сервис строит клиент до сопряжения (fp ещё нет) — это не должно падать
        assertNotNull(Tls.buildClient(null));
    }
}
