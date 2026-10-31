package com.q.claudebridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.InputStream;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;

import javax.net.ssl.X509TrustManager;

public class TlsTest {

    // Самоподписанный EC-сертификат (только сертификат, без ключа), сгенерирован keytool;
    // SHA-256 его DER — отпечаток, как его считает мост (bridge/lib/cert.js) и Tls.fingerprint
    private static final String FIXTURE_FP = "1b8be8c30d4e17e23b0b7d29fd6c479c7b01154746554e87ebd848ec7e5d706e";

    private static X509Certificate fixture() throws Exception {
        try (InputStream in = TlsTest.class.getClassLoader().getResourceAsStream("bridge-test-cert.crt")) {
            assertNotNull("нет src/test/resources/bridge-test-cert.crt", in);
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
        }
    }

    private static void assertRejects(X509TrustManager tm, X509Certificate[] chain) {
        try {
            tm.checkServerTrusted(chain, "ECDHE_ECDSA");
            fail("сертификат принят");
        } catch (CertificateException expected) {
            // ok
        }
    }

    @Test
    public void fingerprintIsSha256OfDer() throws Exception {
        assertEquals(FIXTURE_FP, Tls.fingerprint(fixture()));
    }

    @Test
    public void matchingFingerprintIsAccepted() throws Exception {
        X509Certificate c = fixture();
        Tls.pinnedTrust(FIXTURE_FP).checkServerTrusted(new X509Certificate[]{c}, "ECDHE_ECDSA");
        Tls.pinnedTrust(FIXTURE_FP.toUpperCase()).checkServerTrusted(new X509Certificate[]{c}, "ECDHE_ECDSA");
    }

    @Test
    public void mismatchingFingerprintIsRejected() throws Exception {
        X509Certificate c = fixture();
        String other = (FIXTURE_FP.charAt(0) == '0' ? "1" : "0") + FIXTURE_FP.substring(1);
        assertRejects(Tls.pinnedTrust(other), new X509Certificate[]{c});
        assertRejects(Tls.pinnedTrust("00".repeat(32)), new X509Certificate[]{c});
    }

    @Test
    public void withoutPinnedFingerprintEverythingIsRejected() throws Exception {
        // L-17: TOFU нигде — без отпечатка доверия нет (fail closed)
        X509TrustManager tm = Tls.pinnedTrust(null);
        assertRejects(tm, new X509Certificate[]{fixture()});
        assertRejects(tm, new X509Certificate[0]);
        assertRejects(tm, null);
        assertRejects(Tls.pinnedTrust(""), new X509Certificate[]{fixture()});
    }

    @Test
    public void emptyChainIsRejectedEvenWithPin() {
        assertRejects(Tls.pinnedTrust(FIXTURE_FP), new X509Certificate[0]);
        assertRejects(Tls.pinnedTrust(FIXTURE_FP), null);
    }

    @Test
    public void clientWithoutPinCanBeBuiltButTrustsNothing() {
        // сервис строит клиент до сопряжения (fp ещё нет) — это не должно падать
        assertNotNull(Tls.buildClient(null));
    }
}
