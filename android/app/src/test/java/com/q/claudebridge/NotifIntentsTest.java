package com.q.claudebridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

/**
 * C-1: идентичность PendingIntent задаётся data-URI, а не номером запроса из памяти процесса —
 * иначе после рестарта процесса кнопка старого уведомления получала extras нового запроса.
 */
public class NotifIntentsTest {

    private static final String S = "s3-a1b2c3";

    @Test
    public void replyDataIsUniquePerSessionRequestAndDecision() {
        Set<String> seen = new HashSet<>();
        for (String sid : new String[]{"s3-a1b2c3", "s4-a1b2c3"}) {
            for (String rid : new String[]{"req_1", "req_2", "per_1"}) {
                for (String d : new String[]{"once", "always", "reject"}) {
                    String ssp = NotifIntents.replySsp(sid, rid, d);
                    assertNotNull(ssp);
                    assertTrue("повтор data: " + ssp, seen.add(ssp));
                }
            }
        }
    }

    @Test
    public void replyRoundTripAndValidation() {
        NotifIntents.Reply r = NotifIntents.parseReply(NotifIntents.REPLY, NotifIntents.replySsp(S, "req_00ff", "reject"));
        assertNotNull(r);
        assertEquals(S, r.sessionId);
        assertEquals("req_00ff", r.requestId);
        assertEquals("reject", r.decision);
        assertNull(NotifIntents.replySsp("../x", "req_1", "once"));
        assertNull(NotifIntents.replySsp(S, "req/1", "once"));
        assertNull(NotifIntents.replySsp(S, "req_1", "yes"));
        // чужая схема, лишние/недостающие части, кривые значения — отказ
        assertNull(NotifIntents.parseReply(NotifIntents.CONFIRM, S + "/req_1/once"));
        assertNull(NotifIntents.parseReply(NotifIntents.REPLY, S + "/req_1"));
        assertNull(NotifIntents.parseReply(NotifIntents.REPLY, S + "/req_1/once/x"));
        assertNull(NotifIntents.parseReply(NotifIntents.REPLY, S + "/req 1/once"));
        assertNull(NotifIntents.parseReply(NotifIntents.REPLY, "s3/req_1/once"));
        assertNull(NotifIntents.parseReply(NotifIntents.REPLY, null));
        assertNull(NotifIntents.parseReply(null, S + "/req_1/once"));
    }

    @Test
    public void confirmDataIsUniqueAndParsed() {
        String allow = NotifIntents.confirmSsp("cf_0011", true);
        String deny = NotifIntents.confirmSsp("cf_0011", false);
        String other = NotifIntents.confirmSsp("cf_0022", true);
        assertNotEquals(allow, deny);
        assertNotEquals(allow, other);
        NotifIntents.Confirm c = NotifIntents.parseConfirm(NotifIntents.CONFIRM, allow);
        assertEquals("cf_0011", c.confirmId);
        assertTrue(c.allow);
        assertFalse(NotifIntents.parseConfirm(NotifIntents.CONFIRM, deny).allow);
        assertNull(NotifIntents.confirmSsp("cf bad", true));
        assertNull(NotifIntents.parseConfirm(NotifIntents.CONFIRM, "cf_0011/yes"));
        assertNull(NotifIntents.parseConfirm(NotifIntents.CONFIRM, "cf_0011"));
        assertNull(NotifIntents.parseConfirm(NotifIntents.REPLY, allow));
    }

    @Test
    public void openAndDismissDataAreUniquePerNotificationAndEpoch() {
        assertNotEquals(NotifIntents.openSsp("e1", 100, S), NotifIntents.openSsp("e1", 101, S));
        assertNotEquals(NotifIntents.openSsp("e1", 100, S), NotifIntents.openSsp("e2", 100, S));
        assertNotEquals(NotifIntents.dismissSsp("e1", 100), NotifIntents.dismissSsp("e1", 101));
        assertNotEquals(NotifIntents.dismissSsp("e1", 100), NotifIntents.dismissSsp("e2", 100));
        // «смахнули» уведомление этого процесса — id; чужая эпоха (прошлый процесс) — игнор
        assertEquals(Integer.valueOf(100), NotifIntents.parseDismiss(NotifIntents.DISMISS, NotifIntents.dismissSsp("e1", 100), "e1"));
        assertNull(NotifIntents.parseDismiss(NotifIntents.DISMISS, NotifIntents.dismissSsp("e0", 100), "e1"));
        assertNull(NotifIntents.parseDismiss(NotifIntents.REPLY, NotifIntents.dismissSsp("e1", 100), "e1"));
        assertNull(NotifIntents.parseDismiss(NotifIntents.DISMISS, "e1/x", "e1"));
    }

    @Test
    public void schemesAreDistinct() {
        Set<String> s = new HashSet<>();
        for (String x : new String[]{NotifIntents.REPLY, NotifIntents.CONFIRM, NotifIntents.OPEN, NotifIntents.DISMISS}) {
            assertTrue(s.add(x));
        }
    }
}
