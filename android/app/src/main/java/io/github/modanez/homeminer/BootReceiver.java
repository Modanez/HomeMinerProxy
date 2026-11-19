package io.github.modanez.homeminer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

// Abre o painel quando o aparelho liga, se a opção estiver marcada na tela de configuração do app.
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (!ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE).getBoolean("boot", false)) return;
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(open);
    }
}
