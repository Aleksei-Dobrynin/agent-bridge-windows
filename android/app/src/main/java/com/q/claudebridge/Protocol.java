package com.q.claudebridge;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Чистые функции протокола моста (D-4, D-13, M-4) без Android API — тестируются на JVM.
 * Кнопки уведомлений рисуются по choices от моста; ответ — семантический reply.
 */
final class Protocol {

    static final class Choice {
        final String id;
        final String label;

        Choice(String id, String label) {
            this.id = id;
            this.label = label;
        }
    }

    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern SESSION_ID = Pattern.compile("s\\d{1,9}-[0-9a-f]{6}");
    private static final Pattern CHECK_CODE = Pattern.compile("\\d{4}");

    static boolean validRequestId(String s) {
        return s != null && REQUEST_ID.matcher(s).matches();
    }

    static boolean validSessionId(String s) {
        return s != null && SESSION_ID.matcher(s).matches();
    }

    static boolean validDecision(String d) {
        return "once".equals(d) || "always".equals(d) || "reject".equals(d);
    }

    /** D-22.3: контрольный код запроса подтверждения — 4 цифры. */
    static boolean validCheckCode(String s) {
        return s != null && CHECK_CODE.matcher(s).matches();
    }

    /** choices из notify: только once/always/reject с непустой подписью, без повторов, не больше трёх. */
    static List<Choice> parseChoices(JSONArray arr) {
        if (arr == null) return Collections.emptyList();
        List<Choice> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < arr.length() && out.size() < 3; i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            String label = o.optString("label", "").trim();
            if (!validDecision(id) || label.isEmpty() || seen.contains(id)) continue;
            seen.add(id);
            // подпись уже конкретизирована мостом (D-23.6) — показываем как есть
            out.add(new Choice(id, label.length() > 40 ? label.substring(0, 40) : label));
        }
        return out;
    }

    /** M-4: на API < 31 кнопку нельзя защитить разблокировкой — «Всегда» не показываем. */
    static List<Choice> visibleChoices(List<Choice> all, int sdk) {
        if (sdk >= 31) return all;
        List<Choice> out = new ArrayList<>();
        for (Choice c : all) if (!"always".equals(c.id)) out.add(c);
        return out;
    }

    /** При биометрии на API < 31 кнопок нет вовсе (как раньше). */
    static boolean canShowActions(int sdk, boolean biolock) {
        return sdk >= 31 || !biolock;
    }

    static String replyJson(String sessionId, String requestId, String decision) {
        if (!validSessionId(sessionId) || !validRequestId(requestId) || !validDecision(decision)) return null;
        try {
            return new JSONObject().put("type", "reply").put("id", sessionId)
                    .put("requestId", requestId).put("decision", decision).toString();
        } catch (JSONException e) {
            return null;
        }
    }

    static String confirmJson(String confirmId, boolean allow) {
        if (!validRequestId(confirmId)) return null;
        try {
            return new JSONObject().put("type", "confirm").put("confirmId", confirmId)
                    .put("allow", allow).toString();
        } catch (JSONException e) {
            return null;
        }
    }

    /** Текст уведомления-подтверждения D-13 с контрольным кодом D-22.3 для сверки с консолью ПК. */
    static String confirmText(String message, String checkCode) {
        StringBuilder sb = new StringBuilder(
                message == null || message.trim().isEmpty() ? "Разрешить операцию на ПК?" : message.trim());
        if (validCheckCode(checkCode)) sb.append("\nСверьте код: ").append(checkCode);
        sb.append("\nЕсли вы этого не запускали — отклоните.");
        return sb.toString();
    }

    // ------------------------------------------------------------ сопряжение по QR (P-7, M-2)

    static final class PairingQr {
        final String host;
        final int port;
        final String code;
        final String fp;

        PairingQr(String host, int port, String code, String fp) {
            this.host = host;
            this.port = port;
            this.code = code;
            this.fp = fp;
        }
    }

    private static final Pattern QR_HOST = Pattern.compile("[A-Za-z0-9.-]{1,253}");
    private static final Pattern FINGERPRINT = Pattern.compile("[0-9a-fA-F]{64}");

    /**
     * QR сопряжения {cb:1, host, port, code, fp}. Отпечаток обязателен (H-2); host — имя хоста
     * или IPv4 (только [A-Za-z0-9.-]), port — 1..65535 (M-2): они попадают в URL запроса /pair.
     * Ошибка — IllegalArgumentException с текстом для пользователя.
     */
    static PairingQr parsePairingQr(String raw) {
        final String notOurs = "Это не QR-код Claude Bridge";
        JSONObject j;
        try {
            j = new JSONObject(raw);
        } catch (Exception e) {
            throw new IllegalArgumentException(notOurs);
        }
        String fp = j.optString("fp", "");
        String code = j.optString("code", "");
        if (j.optInt("cb") != 1 || !FINGERPRINT.matcher(fp).matches()
                || code.isEmpty() || code.length() > 64) {
            throw new IllegalArgumentException(notOurs);
        }
        String host = j.optString("host", "");
        if (!QR_HOST.matcher(host).matches()) {
            throw new IllegalArgumentException("Некорректный адрес компьютера в QR-коде");
        }
        int port = 8790;
        if (j.has("port")) {
            Object p = j.opt("port");
            if (!(p instanceof Integer)) throw new IllegalArgumentException("Некорректный порт в QR-коде");
            port = (Integer) p;
        }
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Некорректный порт в QR-коде");
        return new PairingQr(host, port, code, fp.toLowerCase(java.util.Locale.ROOT));
    }

    // ------------------------------------------------------------ учётные данные (M-5)

    enum Credentials { NONE, OK, REPAIR }

    /** Токен без отпечатка — подключаться нельзя (TOFU нет, L-17): нужно сопрячь заново. */
    static Credentials credentials(String token, String fp) {
        if (token == null || token.isEmpty()) return Credentials.NONE;
        return fp == null || fp.isEmpty() ? Credentials.REPAIR : Credentials.OK;
    }

    private Protocol() { }
}
