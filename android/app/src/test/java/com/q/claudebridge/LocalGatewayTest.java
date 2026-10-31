package com.q.claudebridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;

public class LocalGatewayTest {

    private static String head(String... headers) {
        StringBuilder sb = new StringBuilder("GET /ws?cbnonce=abc HTTP/1.1\r\n");
        for (String h : headers) sb.append(h).append("\r\n");
        return sb.append("\r\n").toString();
    }

    private static String rewrite(String head, String token) {
        return new String(LocalGateway.upgradeHead(head.getBytes(StandardCharsets.ISO_8859_1), token),
                StandardCharsets.ISO_8859_1);
    }

    private static int count(String s, String sub) {
        int n = 0;
        for (int i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + 1)) n++;
        return n;
    }

    @Test
    public void originIsReplacedWithFixedWebViewOrigin() {
        // D-15.12: запасной случайный порт шлюза не должен давать 403 от allowlist моста
        String out = rewrite(head("Host: 127.0.0.1:38472", "Origin: http://127.0.0.1:41234",
                "Upgrade: websocket"), "ab12");
        assertTrue(out.startsWith("GET /ws?cbnonce=abc HTTP/1.1\r\n"));
        assertTrue(out.endsWith("\r\n\r\n"));
        assertFalse(out.contains("41234"));
        assertEquals(1, count(out.toLowerCase(), "\r\norigin:"));
        assertTrue(out.contains("\r\nOrigin: http://127.0.0.1:38471\r\n"));
        assertTrue(out.contains("\r\nCookie: bridgeToken=ab12\r\n"));
        assertTrue(out.contains("\r\nHost: 127.0.0.1:38472\r\n"));
        assertTrue(out.contains("\r\nUpgrade: websocket\r\n"));
    }

    @Test
    public void originHeaderNameIsCaseInsensitive() {
        String out = rewrite(head("origin:http://evil", "ORIGIN : http://evil2"), "ab12");
        assertFalse(out.contains("evil"));
        assertEquals(1, count(out.toLowerCase(), "\r\norigin:"));
    }

    @Test
    public void originIsAddedWhenAbsentAndTokenIsSanitized() {
        String out = rewrite(head("Host: x"), "ab\r\nX-Evil: 1");
        assertTrue(out.contains("\r\nOrigin: http://127.0.0.1:38471\r\n"));
        assertFalse(out.contains("\r\nX-Evil"));
        assertTrue(out.endsWith("\r\n\r\n"));
    }
}
