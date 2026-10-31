package com.q.claudebridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class RequestNotificationsTest {

    @Test
    public void eachOpenRequestHasItsOwnNotification() {
        // D-23.3: запросы субагентов opencode — несколько открытых запросов в одной сессии
        RequestNotifications rn = new RequestNotifications(100);
        RequestNotifications.Placement a = rn.onEvent("s1-aaaaaa", "request", "per_1");
        RequestNotifications.Placement b = rn.onEvent("s1-aaaaaa", "request", "per_2");
        assertTrue(a.isNew);
        assertTrue(b.isNew);
        assertNotEquals(a.nid, b.nid);
        assertTrue(b.cancel.isEmpty()); // второй запрос не гасит первый
        // requestClosed снимает ровно своё уведомление
        assertEquals(Integer.valueOf(a.nid), rn.onRequestClosed("s1-aaaaaa", "per_1"));
        assertNull(rn.onRequestClosed("s1-aaaaaa", "per_1"));
        assertEquals(Integer.valueOf(b.nid), rn.onRequestClosed("s1-aaaaaa", "per_2"));
    }

    @Test
    public void sameRequestIdInDifferentSessionsIsDistinct() {
        RequestNotifications rn = new RequestNotifications(1);
        int a = rn.onEvent("s1-aaaaaa", "request", "req_1").nid;
        int b = rn.onEvent("s2-bbbbbb", "request", "req_1").nid;
        assertNotEquals(a, b);
        assertNull(rn.onRequestClosed("s3-cccccc", "req_1"));
        assertEquals(Integer.valueOf(b), rn.onRequestClosed("s2-bbbbbb", "req_1"));
    }

    @Test
    public void replayedRequestUpdatesInPlace() {
        // D-20: мост заново шлёт открытые запросы переподключившемуся клиенту
        RequestNotifications rn = new RequestNotifications(100);
        RequestNotifications.Placement first = rn.onEvent("s1-aaaaaa", "request", "req_1");
        RequestNotifications.Placement again = rn.onEvent("s1-aaaaaa", "request", "req_1");
        assertFalse(again.isNew);
        assertEquals(first.nid, again.nid);
        assertTrue(again.cancel.isEmpty());
    }

    @Test
    public void otherEventsReplaceEachOtherButNotRequests() {
        RequestNotifications rn = new RequestNotifications(100);
        int req = rn.onEvent("s1-aaaaaa", "request", "req_1").nid;
        int info = rn.onEvent("s1-aaaaaa", "info", null).nid;
        RequestNotifications.Placement info2 = rn.onEvent("s1-aaaaaa", "info", null);
        assertEquals(Collections.singletonList(info), info2.cancel); // прежнее событие сессии заменено
        assertFalse(info2.cancel.contains(req));
        // новый запрос заменяет информационное уведомление своей сессии
        RequestNotifications.Placement req2 = rn.onEvent("s1-aaaaaa", "request", "req_2");
        assertEquals(Collections.singletonList(info2.nid), req2.cancel);
        assertEquals(Integer.valueOf(req), rn.onRequestClosed("s1-aaaaaa", "req_1"));
    }

    @Test
    public void doneIsSweptByAnyNewEvent() {
        RequestNotifications rn = new RequestNotifications(100);
        int done1 = rn.onEvent("s1-aaaaaa", "done", null).nid;
        RequestNotifications.Placement i1 = rn.onEvent("s1-bbbbbb", "info", null);
        assertEquals(Collections.singletonList(done1), i1.cancel); // событие другой сессии гасит done
        int info1 = i1.nid;
        RequestNotifications.Placement d2 = rn.onEvent("s2-bbbbbb", "done", null);
        assertTrue(d2.cancel.isEmpty()); // info другой сессии не трогаем
        RequestNotifications.Placement p = rn.onEvent("s3-cccccc", "request", "req_9");
        assertEquals(Arrays.asList(d2.nid), p.cancel);
        assertEquals(Integer.valueOf(info1), rn.onWorking("s1-bbbbbb"));
        // уже снятые больше не возвращаются
        assertTrue(rn.onEvent("s4-dddddd", "info", null).cancel.isEmpty());
    }

    @Test
    public void workingClearsOnlyNonRequestNotification() {
        RequestNotifications rn = new RequestNotifications(100);
        int req = rn.onEvent("s1-aaaaaa", "request", "req_1").nid;
        int info = rn.onEvent("s1-aaaaaa", "info", null).nid;
        assertEquals(Integer.valueOf(info), rn.onWorking("s1-aaaaaa"));
        assertNull(rn.onWorking("s1-aaaaaa"));
        assertEquals(Integer.valueOf(req), rn.onRequestClosed("s1-aaaaaa", "req_1"));
    }

    @Test
    public void globalInfoWithoutSessionIsNotTracked() {
        RequestNotifications rn = new RequestNotifications(100);
        RequestNotifications.Placement a = rn.onEvent("", "info", null);
        RequestNotifications.Placement b = rn.onEvent("", "info", null);
        assertNotEquals(a.nid, b.nid);
        assertTrue(b.cancel.isEmpty()); // «устройство отозвано» и т.п. не заменяют друг друга
        assertNull(rn.onWorking(""));
    }

    @Test
    public void idsAreSharedWithOtherNotifications() {
        RequestNotifications rn = new RequestNotifications(100);
        int e = rn.onEvent("s1-aaaaaa", "request", "req_1").nid;
        int c = rn.nextId();
        int e2 = rn.onEvent("s1-aaaaaa", "request", "req_2").nid;
        assertEquals(100, e);
        assertEquals(101, c);
        assertEquals(102, e2);
    }
}
