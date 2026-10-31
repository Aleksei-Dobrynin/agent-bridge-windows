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
}
