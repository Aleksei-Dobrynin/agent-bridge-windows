package com.q.claudebridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.List;

public class ProtocolTest {

    private static JSONArray choices() throws Exception {
        return new JSONArray("[{\"id\":\"once\",\"label\":\"Да\"},{\"id\":\"always\",\"label\":\"Всегда\"},"
                + "{\"id\":\"evil\",\"label\":\"x\"},{\"id\":\"reject\",\"label\":\"  \"},"
                + "{\"id\":\"reject\",\"label\":\"Нет\"},{\"id\":\"once\",\"label\":\"Дубль\"}]");
    }

    @Test
    public void parseChoicesKeepsKnownNonEmptyUnique() throws Exception {
        List<Protocol.Choice> c = Protocol.parseChoices(choices());
        assertEquals(3, c.size());
        assertEquals("once", c.get(0).id);
        assertEquals("Да", c.get(0).label);
        assertEquals("always", c.get(1).id);
        assertEquals("reject", c.get(2).id);
        assertEquals("Нет", c.get(2).label);
        assertTrue(Protocol.parseChoices(null).isEmpty());
    }

    @Test
    public void parseChoicesKeepsConcreteAlwaysLabel() throws Exception {
        // D-23.6: подпись «Всегда» конкретизирует мост — показываем как есть (до 40 символов)
        String label = "Всегда: `npm run *`";
        List<Protocol.Choice> c = Protocol.parseChoices(new JSONArray()
                .put(new JSONObject().put("id", "always").put("label", label)));
        assertEquals(1, c.size());
        assertEquals(label, c.get(0).label);
        String longLabel = "Всегда: доступ к каталогу D:\\Practice\\very\\long\\path\\here";
        List<Protocol.Choice> l = Protocol.parseChoices(new JSONArray()
                .put(new JSONObject().put("id", "always").put("label", longLabel)));
        assertEquals(40, l.get(0).label.length());
    }

    @Test
    public void alwaysIsHiddenBelowApi31() throws Exception {
        List<Protocol.Choice> all = Protocol.parseChoices(choices());
        assertEquals(3, Protocol.visibleChoices(all, 31).size());
        List<Protocol.Choice> old = Protocol.visibleChoices(all, 30);
        assertEquals(2, old.size());
        assertEquals("once", old.get(0).id);
        assertEquals("reject", old.get(1).id);
    }

    @Test
    public void actionsPolicy() {
        assertTrue(Protocol.canShowActions(31, true));
        assertTrue(Protocol.canShowActions(30, false));
        assertFalse(Protocol.canShowActions(30, true));
    }

    @Test
    public void replyJson() throws Exception {
        JSONObject j = new JSONObject(Protocol.replyJson("s3-a1b2c3", "req_0011223344556677", "once"));
        assertEquals("reply", j.getString("type"));
        assertEquals("s3-a1b2c3", j.getString("id"));
        assertEquals("req_0011223344556677", j.getString("requestId"));
        assertEquals("once", j.getString("decision"));
        // requestId opencode (per_…) тоже допустим
        assertEquals("per_1", new JSONObject(Protocol.replyJson("s3-a1b2c3", "per_1", "reject")).getString("requestId"));
        assertNull(Protocol.replyJson("../x", "req_1", "once"));
        assertNull(Protocol.replyJson("s3-a1b2c3", "req 1", "once"));
        assertNull(Protocol.replyJson("s3-a1b2c3", "req_1", "yes"));
        assertNull(Protocol.replyJson(null, "req_1", "once"));
    }

    @Test
    public void confirmJson() throws Exception {
        JSONObject j = new JSONObject(Protocol.confirmJson("cf_0011223344556677", true));
        assertEquals("confirm", j.getString("type"));
        assertEquals("cf_0011223344556677", j.getString("confirmId"));
        assertTrue(j.getBoolean("allow"));
        assertFalse(new JSONObject(Protocol.confirmJson("cf_0011223344556677", false)).getBoolean("allow"));
        assertNull(Protocol.confirmJson("cf bad", false));
        assertNull(Protocol.confirmJson(null, false));
    }

    @Test
    public void confirmTextShowsCheckCode() {
        // D-22.3: контрольный код из confirmRequest — человек сверяет его с консолью ПК
        String t = Protocol.confirmText("Выпустить код сопряжения нового устройства?", "0427");
        assertTrue(t.startsWith("Выпустить код сопряжения нового устройства?"));
        assertTrue(t.contains("Сверьте код: 0427"));
        assertTrue(t.contains("Если вы этого не запускали — отклоните."));
        // без сообщения — общий вопрос; кривой код не показываем
        String d = Protocol.confirmText("", "12a4");
        assertTrue(d.startsWith("Разрешить операцию на ПК?"));
        assertFalse(d.contains("Сверьте код"));
        assertFalse(Protocol.confirmText(null, null).contains("Сверьте код"));
        assertTrue(Protocol.validCheckCode("0000"));
        assertFalse(Protocol.validCheckCode("123"));
        assertFalse(Protocol.validCheckCode("12345"));
        assertFalse(Protocol.validCheckCode(null));
    }

    private static final String FP = "ab".repeat(32);

    private static String qr(String host, Object port, String code, String fp) throws Exception {
        JSONObject j = new JSONObject().put("cb", 1).put("host", host).put("code", code);
        if (port != null) j.put("port", port);
        if (fp != null) j.put("fp", fp);
        return j.toString();
    }

    private static String qrError(String raw) {
        try {
            Protocol.parsePairingQr(raw);
            return null;
        } catch (IllegalArgumentException e) {
            return e.getMessage();
        }
    }

    @Test
    public void pairingQrIsParsed() throws Exception {
        Protocol.PairingQr q = Protocol.parsePairingQr(qr("192.168.1.20", 8790, "A1B2C3", FP.toUpperCase()));
        assertEquals("192.168.1.20", q.host);
        assertEquals(8790, q.port);
        assertEquals("A1B2C3", q.code);
        assertEquals(FP, q.fp); // отпечаток — в нижнем регистре
        assertEquals("my-pc.local", Protocol.parsePairingQr(qr("my-pc.local", null, "X", FP)).host);
        assertEquals(8790, Protocol.parsePairingQr(qr("my-pc.local", null, "X", FP)).port);
    }

    @Test
    public void pairingQrRejectsForeignOrUnpinned() throws Exception {
        // P-7/H-2: без отпечатка или не наш QR — «не тот QR»
        String notOurs = "Это не QR-код Claude Bridge";
        assertEquals(notOurs, qrError("hello"));
        assertEquals(notOurs, qrError(null));
        assertEquals(notOurs, qrError(new JSONObject().put("cb", 2).put("host", "h").put("code", "c").put("fp", FP).toString()));
        assertEquals(notOurs, qrError(qr("h", 8790, "c", null)));
        assertEquals(notOurs, qrError(qr("h", 8790, "c", "abcd")));
        assertEquals(notOurs, qrError(qr("h", 8790, "", FP)));
        assertEquals(notOurs, qrError(qr("h", 8790, "x".repeat(65), FP)));
    }

    @Test
    public void pairingQrRejectsBadHostAndPort() throws Exception {
        // M-2: адрес и порт из QR попадают в URL — только имя хоста/IPv4 и порт 1..65535
        String badHost = "Некорректный адрес компьютера в QR-коде";
        for (String h : new String[]{"", "evil.com/path", "user@host", "host:1", "a b", "x".repeat(254), "[::1]", "хост"}) {
            assertEquals(h, badHost, qrError(qr(h, 8790, "c", FP)));
        }
        String badPort = "Некорректный порт в QR-коде";
        assertEquals(badPort, qrError(qr("h", 0, "c", FP)));
        assertEquals(badPort, qrError(qr("h", 65536, "c", FP)));
        assertEquals(badPort, qrError(qr("h", -1, "c", FP)));
        assertEquals(badPort, qrError(qr("h", "8790x", "c", FP)));
        assertEquals(65535, Protocol.parsePairingQr(qr("h", 65535, "c", FP)).port);
    }

    @Test
    public void credentialsState() {
        // M-5: токен без отпечатка — не переподключаться вслепую, просить сопрячь заново
        assertEquals(Protocol.Credentials.NONE, Protocol.credentials(null, FP));
        assertEquals(Protocol.Credentials.NONE, Protocol.credentials("", null));
        assertEquals(Protocol.Credentials.REPAIR, Protocol.credentials("tok", null));
        assertEquals(Protocol.Credentials.REPAIR, Protocol.credentials("tok", ""));
        assertEquals(Protocol.Credentials.OK, Protocol.credentials("tok", FP));
    }
}
