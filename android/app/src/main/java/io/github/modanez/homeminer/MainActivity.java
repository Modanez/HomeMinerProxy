package io.github.modanez.homeminer;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;

// Tela cheia com o painel em modo quiosque. Na primeira vez pede o endereço do painel; ☰ (menu) no controle abre de novo.
// A página recebe "?kiosk&vw=1920": o painel ajusta o viewport para 1920 px de largura e o WebView reduz para caber na
// TV (no Fire Stick o navegador usaria 960×540, com letras enormes e pouca coisa por tela).
public class MainActivity extends Activity {
    static final String PREFS = "homeminer";
    static final String DEFAULT_URL = "http://homeminer.local";

    private WebView web;
    private SharedPreferences prefs;
    private AlertDialog setup;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1117"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // som de recorde
        s.setUseWideViewPort(true);                     // respeita o viewport de 1920 px que a página pede
        s.setLoadWithOverviewMode(true);                // e reduz para caber na tela
        s.setSupportZoom(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) { return false; }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (Build.VERSION.SDK_INT >= 23 && req.isForMainFrame()) showError(String.valueOf(err.getDescription()));
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                if (Build.VERSION.SDK_INT < 23) showError(desc);
            }
        });
        setContentView(web);

        if (prefs.getString("url", null) == null) showSetup(); else load();
    }

    @Override
    protected void onResume() {
        super.onResume();
        immersive();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    private void immersive() {
        if (Build.VERSION.SDK_INT >= 19) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    // http://homeminer.local → http://homeminer.local/?kiosk&vw=1920
    static String kioskUrl(String base, int vw) {
        String u = base.trim();
        if (!u.matches("(?i)^https?://.*")) u = "http://" + u;
        Uri p = Uri.parse(u);
        Uri.Builder b = p.buildUpon();
        if (TextUtils.isEmpty(p.getPath())) b.path("/");
        b.encodedQuery(vw > 0 ? "kiosk&vw=" + vw : "kiosk");
        return b.build().toString();
    }

    private String target() {
        return kioskUrl(prefs.getString("url", DEFAULT_URL), prefs.getInt("vw", 1920));
    }

    private void load() {
        web.loadUrl(target());
        web.requestFocus();
    }

    private void showError(String why) {
        String url = target();
        String safe = TextUtils.htmlEncode(url), reason = TextUtils.htmlEncode(why == null ? "" : why);
        String html = "<!doctype html><meta name=viewport content='width=device-width'>"
                + "<body style='margin:0;background:#0e1117;color:#e6e9ef;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center'>"
                + "<div><div style='font-size:56px'>⛏️</div><h2 style='color:#f2a900'>" + TextUtils.htmlEncode(getString(R.string.err_title)) + "</h2>"
                + "<p>" + safe + "</p><p style='color:#8a93a6'>" + reason + "</p>"
                + "<p style='color:#8a93a6'>" + TextUtils.htmlEncode(getString(R.string.err_retry)) + "</p></div>"
                + "<script>setTimeout(function(){location.href=" + jsString(url) + "},15000)</script>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String jsString(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("<", "\\u003c") + "'";
    }

    private void showSetup() {
        if (setup != null && setup.isShowing()) return;
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);

        TextView l1 = new TextView(this);
        l1.setText(R.string.setup_url);
        box.addView(l1);
        final EditText url = new EditText(this);
        url.setSingleLine(true);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(prefs.getString("url", DEFAULT_URL));
        box.addView(url);

        TextView l2 = new TextView(this);
        l2.setText(R.string.setup_size);
        l2.setPadding(0, pad / 2, 0, 0);
        box.addView(l2);
        final RadioGroup size = new RadioGroup(this);
        final int[] values = {1920, 1280, 0};
        final int[] labels = {R.string.size_1920, R.string.size_1280, R.string.size_device};
        int cur = prefs.getInt("vw", 1920);
        for (int i = 0; i < values.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setId(1000 + i);
            r.setText(labels[i]);
            size.addView(r);
            if (values[i] == cur) size.check(r.getId());
        }
        box.addView(size);

        final CheckBox boot = new CheckBox(this);
        boot.setText(R.string.setup_boot);
        boot.setChecked(prefs.getBoolean("boot", false));
        box.addView(boot);

        TextView hint = new TextView(this);
        hint.setText(R.string.setup_hint);
        hint.setPadding(0, pad / 2, 0, 0);
        box.addView(hint);

        setup = new AlertDialog.Builder(this)
                .setTitle(R.string.setup_title)
                .setView(box)
                .setCancelable(prefs.getString("url", null) != null)
                .setPositiveButton(R.string.save, (d, w) -> {
                    String u = url.getText().toString().trim();
                    int checked = size.getCheckedRadioButtonId() - 1000;
                    prefs.edit()
                            .putString("url", u.isEmpty() ? DEFAULT_URL : u)
                            .putInt("vw", checked >= 0 && checked < values.length ? values[checked] : 1920)
                            .putBoolean("boot", boot.isChecked())
                            .apply();
                    load();
                })
                .setNegativeButton(R.string.cancel, (d, w) -> { if (prefs.getString("url", null) == null) finish(); })
                .create();
        setup.show();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_MENU || e.getKeyCode() == KeyEvent.KEYCODE_SETTINGS) {
            if (e.getAction() == KeyEvent.ACTION_UP) showSetup();
            return true;
        }
        return super.dispatchKeyEvent(e);
    }
}
