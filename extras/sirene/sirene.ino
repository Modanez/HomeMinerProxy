// Sirene da fazenda de mineração
// Arduino Uno ligado ao Odroid pela USB (9600 baud). O painel (mining.js) manda 1 caractere por evento:
//   R = recorde da fazenda   P = recorde pessoal de um worker   S = share aceito   T = teste (igual ao R)
//   r / p / s = os mesmos eventos sem som (horário de silêncio)
//   0 / 1 / 2 = estado da fazenda: tudo ok / alguém sem share recente / alguém parado
//
// Ligações (cada LED com resistor de 220 ohms em série, perna comprida no pino):
//   LED verde    -> pino 5
//   LED amarelo  -> pino 6
//   LED vermelho -> pino 9
//   speaker      -> pino 8, com resistor de 100 ohms em série; o outro fio no GND

const int LED_VERDE = 5;
const int LED_AMARELO = 6;
const int LED_VERMELHO = 9;
const int SPEAKER = 8;

int estado = 0;   // 0 ok, 1 sem share recente, 2 parado

void leds(int verde, int amarelo, int vermelho) {
  analogWrite(LED_VERDE, verde);
  analogWrite(LED_AMARELO, amarelo);
  analogWrite(LED_VERMELHO, vermelho);
}

void nota(int freq, int ms, bool som) {
  if (som && freq > 0) tone(SPEAKER, freq, ms);
  delay(ms);
  noTone(SPEAKER);
}

// Fanfarra + estrobo (~6 s)
void recorde(bool som) {
  const int melodia[] = { 392, 523, 659, 784, 0, 659, 784 };   // sol, dó, mi, sol ... mi, sol
  const int duracao[] = { 150, 150, 150, 300, 100, 150, 500 };
  for (int i = 0; i < 7; i++) {
    if (i % 2 == 0) leds(255, 255, 255); else leds(0, 0, 0);
    nota(melodia[i], duracao[i], som);
  }
  for (int i = 0; i < 24; i++) {
    leds(i % 3 == 0 ? 255 : 0, i % 3 == 1 ? 255 : 0, i % 3 == 2 ? 255 : 0);
    delay(150);
  }
  leds(0, 0, 0);
}

// Arpejo curto + flash verde/amarelo
void pessoal(bool som) {
  const int melodia[] = { 523, 659, 784 };
  for (int i = 0; i < 3; i++) {
    leds(255, 255, 0);
    nota(melodia[i], 120, som);
    leds(0, 0, 0);
    delay(60);
  }
}

// Blip baixinho + piscada verde
void share(bool som) {
  leds(255, 0, 0);
  nota(1760, 40, som);
  delay(160);
  leds(0, 0, 0);
}

// Luz de repouso conforme o estado (sem travar o loop)
void repouso() {
  unsigned long t = millis();
  if (estado == 0) {
    int f = (t / 8) % 512;                 // "respira" a cada ~4 s
    int v = f < 256 ? f : 511 - f;
    leds(v / 4, 0, 0);
  } else if (estado == 1) {
    leds(0, 60, 0);
  } else {
    leds(0, 0, (t / 500) % 2 ? 140 : 0);   // vermelho piscando
  }
}

void setup() {
  pinMode(LED_VERDE, OUTPUT);
  pinMode(LED_AMARELO, OUTPUT);
  pinMode(LED_VERMELHO, OUTPUT);
  pinMode(SPEAKER, OUTPUT);
  Serial.begin(9600);
  // animação de boot: acende um de cada vez e dá um bip
  leds(255, 0, 0); delay(150);
  leds(0, 255, 0); delay(150);
  leds(0, 0, 255); delay(150);
  leds(0, 0, 0);
  nota(1320, 60, true);
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    switch (c) {
      case 'R': case 'T': recorde(true); break;
      case 'r': recorde(false); break;
      case 'P': pessoal(true); break;
      case 'p': pessoal(false); break;
      case 'S': share(true); break;
      case 's': share(false); break;
      case '0': case '1': case '2': estado = c - '0'; break;
    }
  }
  repouso();
}
