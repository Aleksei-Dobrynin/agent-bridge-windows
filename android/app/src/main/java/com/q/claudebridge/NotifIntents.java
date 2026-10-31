package com.q.claudebridge;

/**
 * Data-URI для PendingIntent уведомлений (C-1), без Android API — тестируется на JVM.
 * <p>
 * Система различает PendingIntent по action/data/component (не по extras). Если интенты кнопок
 * различаются лишь requestCode из памяти процесса, после рестарта процесса новый
 * {@code getService(…, FLAG_UPDATE_CURRENT)} с тем же номером переписывает extras кнопки
 * старого уведомления — «Нет» старого запроса отправило бы «Да» новому, «Разрешить»
 * одобрило бы новую операцию владельца. Поэтому всё значимое кодируется в data
 * (схема + scheme-specific part), а обработчик читает значения только из data.
 */
final class NotifIntents {

    static final String REPLY = "cbreply";     // reply: сессия/запрос/решение
    static final String CONFIRM = "cbconfirm"; // confirm: confirmId/true|false
    static final String OPEN = "cbopen";       // тап по уведомлению: эпоха/id/сессия
    static final String DISMISS = "cbdismiss"; // смахнули уведомление: эпоха/id

    static final class Reply {
        final String sessionId;
        final String requestId;
        final String decision;

        Reply(String sessionId, String requestId, String decision) {
            this.sessionId = sessionId;
            this.requestId = requestId;
            this.decision = decision;
        }
    }

    static final class Confirm {
        final String confirmId;
        final boolean allow;

        Confirm(String confirmId, boolean allow) {
            this.confirmId = confirmId;
            this.allow = allow;
        }
    }

    static String replySsp(String sessionId, String requestId, String decision) {
        if (!Protocol.validSessionId(sessionId) || !Protocol.validRequestId(requestId)
                || !Protocol.validDecision(decision)) return null;
        return sessionId + "/" + requestId + "/" + decision;
    }

    static Reply parseReply(String scheme, String ssp) {
        if (!REPLY.equals(scheme) || ssp == null) return null;
        String[] p = ssp.split("/", -1);
        if (p.length != 3 || replySsp(p[0], p[1], p[2]) == null) return null;
        return new Reply(p[0], p[1], p[2]);
    }

    static String confirmSsp(String confirmId, boolean allow) {
        if (!Protocol.validRequestId(confirmId)) return null;
        return confirmId + "/" + allow;
    }

    static Confirm parseConfirm(String scheme, String ssp) {
        if (!CONFIRM.equals(scheme) || ssp == null) return null;
        String[] p = ssp.split("/", -1);
        if (p.length != 2 || !Protocol.validRequestId(p[0])) return null;
        if (!"true".equals(p[1]) && !"false".equals(p[1])) return null;
        return new Confirm(p[0], "true".equals(p[1]));
    }

    /** Тап по уведомлению: уникален на уведомление процесса (epoch — случайная метка процесса). */
    static String openSsp(String epoch, int nid, String sessionId) {
        return epoch + "/" + nid + "/" + (sessionId == null ? "" : sessionId);
    }

    static String dismissSsp(String epoch, int nid) {
        return epoch + "/" + nid;
    }

    /** id смахнутого уведомления этого процесса; уведомление прошлого процесса — null. */
    static Integer parseDismiss(String scheme, String ssp, String epoch) {
        if (!DISMISS.equals(scheme) || ssp == null || epoch == null) return null;
        String[] p = ssp.split("/", -1);
        if (p.length != 2 || !p[0].equals(epoch) || !p[1].matches("\\d{1,9}")) return null;
        return Integer.valueOf(p[1]);
    }

    private NotifIntents() { }
}
