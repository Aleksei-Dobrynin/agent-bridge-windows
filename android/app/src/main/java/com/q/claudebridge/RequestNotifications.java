package com.q.claudebridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Учёт событийных уведомлений (без Android API — тестируется на JVM).
 * <ul>
 *   <li>у каждого открытого запроса разрешения — своё уведомление (ключ: сессия + requestId):
 *       в сессии может быть несколько запросов сразу (субагенты opencode, D-23.3);
 *       {@code requestClosed} снимает ровно его, повтор того же запроса (D-20) — на месте;</li>
 *   <li>прочие события сессии (info/done) — одно уведомление на сессию, новое заменяет прежнее;
 *       запросы при этом не трогаются;</li>
 *   <li>«агент завершил ответ» (done) устаревает при любом новом событии;</li>
 *   <li>события без сессии (уведомления моста об устройствах) не отслеживаются.</li>
 * </ul>
 * Потокобезопасен: все методы synchronized.
 */
final class RequestNotifications {

    /** Куда показать событие: id уведомления и какие уведомления снять. */
    static final class Placement {
        final int nid;
        final List<Integer> cancel;

        Placement(int nid, List<Integer> cancel) {
            this.nid = nid;
            this.cancel = Collections.unmodifiableList(cancel);
        }
    }

    private final Map<String, Integer> requests = new LinkedHashMap<>(); // сессия \0 requestId -> nid
    private final Map<String, Integer> sessionNids = new LinkedHashMap<>(); // сессия -> nid (info/done)
    private final Map<String, String> sessionKinds = new LinkedHashMap<>(); // сессия -> info/done
    private int seq;

    RequestNotifications(int firstId) {
        this.seq = firstId;
    }

    private static String key(String sessionId, String requestId) {
        return sessionId + '\0' + requestId;
    }

    /** Новый id из общего пространства (для других уведомлений, например подтверждений D-13). */
    synchronized int nextId() {
        return seq++;
    }

    /**
     * Пришло событие. requestId != null — открытый запрос с кнопками (вызывающий уже проверил
     * сессию и requestId), иначе — событие kind (info/done) сессии sessionId.
     */
    synchronized Placement onEvent(String sessionId, String kind, String requestId) {
        List<Integer> cancel = new ArrayList<>();
        boolean tracked = sessionId != null && !sessionId.isEmpty();
        if (tracked) {
            Integer prev = sessionNids.remove(sessionId);
            sessionKinds.remove(sessionId);
            if (prev != null) cancel.add(prev);
        }
        Iterator<Map.Entry<String, String>> it = sessionKinds.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, String> e = it.next();
            if (!"done".equals(e.getValue())) continue;
            Integer nid = sessionNids.remove(e.getKey());
            if (nid != null && !cancel.contains(nid)) cancel.add(nid);
            it.remove();
        }
        if (requestId != null && tracked) {
            String k = key(sessionId, requestId);
            Integer existing = requests.get(k);
            if (existing != null) return new Placement(existing, cancel);
            int nid = seq++;
            requests.put(k, nid);
            return new Placement(nid, cancel);
        }
        int nid = seq++;
        if (tracked) {
            sessionNids.put(sessionId, nid);
            sessionKinds.put(sessionId, kind == null ? "" : kind);
        }
        return new Placement(nid, cancel);
    }

    /** Запрос закрыт (ответили где угодно, агент ушёл дальше) — id его уведомления или null. */
    synchronized Integer onRequestClosed(String sessionId, String requestId) {
        if (sessionId == null || requestId == null) return null;
        return requests.remove(key(sessionId, requestId));
    }

    /** Агент снова работает — неактуально информационное уведомление сессии (не запросы). */
    synchronized Integer onWorking(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) return null;
        sessionKinds.remove(sessionId);
        return sessionNids.remove(sessionId);
    }

    /** I-1: связь с мостом установлена заново — мост повторит открытые запросы (D-20). */
    synchronized void clear() {
        requests.clear();
        sessionNids.clear();
        sessionKinds.clear();
    }

    /** I-1: сессий больше нет в списке моста — их уведомления (id для снятия) забываются. */
    synchronized List<Integer> retainSessions(Set<String> alive) {
        List<Integer> gone = new ArrayList<>();
        Iterator<Map.Entry<String, Integer>> r = requests.entrySet().iterator();
        while (r.hasNext()) {
            Map.Entry<String, Integer> e = r.next();
            String sid = e.getKey().substring(0, e.getKey().indexOf('\0'));
            if (!alive.contains(sid)) { gone.add(e.getValue()); r.remove(); }
        }
        Iterator<Map.Entry<String, Integer>> s = sessionNids.entrySet().iterator();
        while (s.hasNext()) {
            Map.Entry<String, Integer> e = s.next();
            if (!alive.contains(e.getKey())) { gone.add(e.getValue()); sessionKinds.remove(e.getKey()); s.remove(); }
        }
        return gone;
    }

    /** I-1: пользователь смахнул уведомление nid — запись учёта удаляется; false — не наше. */
    synchronized boolean onDismissed(int nid) {
        if (requests.values().remove(nid)) return true;
        Iterator<Map.Entry<String, Integer>> s = sessionNids.entrySet().iterator();
        while (s.hasNext()) {
            Map.Entry<String, Integer> e = s.next();
            if (e.getValue() == nid) { sessionKinds.remove(e.getKey()); s.remove(); return true; }
        }
        return false;
    }
}
