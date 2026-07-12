"""Shared HTML/text email templates for nia-todo system emails."""

from __future__ import annotations

from html import escape

BRAND_NAME = "nia-todo"
TEXT_COLOR = "#0f172a"
MUTED_COLOR = "#64748b"
LINK_COLOR = "#4f46e5"
LOGO_CID = "nia-todo-logo"
MAX_SUBJECT_LENGTH = 140


EMAIL_COPY = {
    "de": {
        "auto_sent": "Diese E-Mail wurde automatisch von nia-todo gesendet.",
        "button_fallback": "Falls der Button nicht funktioniert, kopiere diesen Link:",
        "link_fallback": "Falls der Link nicht funktioniert, kopiere diese Adresse:",
        "greeting": "Hallo {name},",
        "greeting_default": "du",
        "tagline": "Deine Aufgaben. Klar sortiert.",
        "system_mail": "System-E-Mail",
        "unexpected": "Wenn du diese E-Mail nicht erwartet hast, kannst du sie ignorieren.",
        "project_share_subject": "Projektfreigabe: {project_name}",
        "project_share_title": "Projektfreigabe erhalten",
        "project_share_paragraph": "{inviter_name} hat das Projekt \"{project_name}\" mit dir geteilt.",
        "project_share_action": "Einladung ansehen",
        "project_share_detail": "Du kannst die Einladung in nia-todo annehmen oder ablehnen.",
        "project_share_preheader": "{inviter_name} hat ein Projekt mit dir geteilt.",
        "email_verify_subject": "nia-todo E-Mail bestätigen",
        "email_verify_title": "E-Mail-Adresse bestätigen",
        "email_verify_paragraph": "Bitte bestätige diese E-Mail-Adresse für dein nia-todo-Konto.",
        "email_verify_action": "E-Mail bestätigen",
        "link_expires_hours": "Der Link ist {hours} Stunden gültig.",
        "email_verify_unexpected": "Wenn du diese Änderung nicht angefordert hast, ignoriere diese E-Mail.",
        "email_verify_preheader": "Bestätige deine E-Mail-Adresse für nia-todo.",
        "password_invite_subject": "Dein nia-todo-Zugang",
        "password_reset_subject": "nia-todo Passwort zurücksetzen",
        "password_invite_title": "Willkommen bei nia-todo",
        "password_reset_title": "Passwort zurücksetzen",
        "password_invite_paragraph": "Für deinen nia-todo-Zugang wurde ein Einrichtungslink erstellt.",
        "password_reset_paragraph": "Für dein nia-todo-Konto wurde ein Passwort-Link erstellt.",
        "password_invite_action": "Passwort festlegen",
        "password_reset_action": "Passwort zurücksetzen",
        "password_unexpected": "Wenn du das nicht erwartet hast, ignoriere diese E-Mail.",
        "password_invite_preheader": "Richte deinen nia-todo-Zugang ein.",
        "password_reset_preheader": "Setze dein nia-todo-Passwort zurück.",
        "security_code": "Sicherheitscode",
        "login_code": "Login-Code",
        "reauth_subject": "Dein nia-todo Reauth-Code",
        "twofa_subject": "Dein nia-todo 2FA-Code",
        "code_paragraph": "Dein {label} lautet:",
        "code_expires_minutes": "Der Code ist {minutes} Minuten gültig.",
        "code_tip": "Tipp: Du kannst in den Einstellungen zusätzlich einen Authenticator oder Passkey einrichten.",
        "code_preheader": "Dein nia-todo {label}: {code}",
        "smtp_test_subject": "nia-todo SMTP-Test",
        "smtp_test_title": "SMTP funktioniert",
        "smtp_test_paragraph": "Wenn du diese E-Mail siehst, funktioniert die SMTP-Konfiguration von nia-todo.",
        "smtp_test_detail": "Diese Test-E-Mail wurde über die aktuell gespeicherte SMTP-Konfiguration versendet.",
        "smtp_test_preheader": "Die SMTP-Konfiguration von nia-todo funktioniert.",
    },
    "en": {
        "auto_sent": "This email was sent automatically by nia-todo.",
        "button_fallback": "If the button does not work, copy this link:",
        "link_fallback": "If the link does not work, copy this address:",
        "greeting": "Hi {name},",
        "greeting_default": "there",
        "tagline": "Your tasks. Clearly organized.",
        "system_mail": "System email",
        "unexpected": "If you did not expect this email, you can ignore it.",
        "project_share_subject": "Project share: {project_name}",
        "project_share_title": "Project shared with you",
        "project_share_paragraph": "{inviter_name} shared the project \"{project_name}\" with you.",
        "project_share_action": "View invitation",
        "project_share_detail": "You can accept or decline the invitation in nia-todo.",
        "project_share_preheader": "{inviter_name} shared a project with you.",
        "email_verify_subject": "Confirm your nia-todo email",
        "email_verify_title": "Confirm email address",
        "email_verify_paragraph": "Please confirm this email address for your nia-todo account.",
        "email_verify_action": "Confirm email",
        "link_expires_hours": "The link is valid for {hours} hours.",
        "email_verify_unexpected": "If you did not request this change, ignore this email.",
        "email_verify_preheader": "Confirm your email address for nia-todo.",
        "password_invite_subject": "Your nia-todo access",
        "password_reset_subject": "Reset your nia-todo password",
        "password_invite_title": "Welcome to nia-todo",
        "password_reset_title": "Reset password",
        "password_invite_paragraph": "A setup link was created for your nia-todo access.",
        "password_reset_paragraph": "A password link was created for your nia-todo account.",
        "password_invite_action": "Set password",
        "password_reset_action": "Reset password",
        "password_unexpected": "If you did not expect this, ignore this email.",
        "password_invite_preheader": "Set up your nia-todo access.",
        "password_reset_preheader": "Reset your nia-todo password.",
        "security_code": "security code",
        "login_code": "login code",
        "reauth_subject": "Your nia-todo reauth code",
        "twofa_subject": "Your nia-todo 2FA code",
        "code_paragraph": "Your {label} is:",
        "code_expires_minutes": "The code is valid for {minutes} minutes.",
        "code_tip": "Tip: You can also add an authenticator or passkey in settings.",
        "code_preheader": "Your nia-todo {label}: {code}",
        "smtp_test_subject": "nia-todo SMTP test",
        "smtp_test_title": "SMTP works",
        "smtp_test_paragraph": "If you can see this email, nia-todo's SMTP configuration works.",
        "smtp_test_detail": "This test email was sent using the currently saved SMTP configuration.",
        "smtp_test_preheader": "nia-todo's SMTP configuration works.",
    },
    "cs": {
        "auto_sent": "Tento e-mail byl automaticky odeslán službou nia-todo.",
        "button_fallback": "Pokud tlačítko nefunguje, zkopíruj tento odkaz:",
        "link_fallback": "Pokud odkaz nefunguje, zkopíruj tuto adresu:",
        "greeting": "Ahoj {name},",
        "greeting_default": "tam",
        "tagline": "Tvé úkoly. Přehledně uspořádané.",
        "system_mail": "Systémový e-mail",
        "unexpected": "Pokud jsi tento e-mail nečekal/a, můžeš ho ignorovat.",
        "project_share_subject": "Sdílení projektu: {project_name}",
        "project_share_title": "Projekt byl s tebou sdílen",
        "project_share_paragraph": "{inviter_name} s tebou sdílí projekt „{project_name}“.",
        "project_share_action": "Zobrazit pozvánku",
        "project_share_detail": "Pozvánku můžeš v nia-todo přijmout nebo odmítnout.",
        "project_share_preheader": "{inviter_name} s tebou sdílí projekt.",
        "email_verify_subject": "Potvrď svůj e-mail pro nia-todo",
        "email_verify_title": "Potvrzení e-mailové adresy",
        "email_verify_paragraph": "Potvrď prosím tuto e-mailovou adresu pro svůj účet nia-todo.",
        "email_verify_action": "Potvrdit e-mail",
        "link_expires_hours": "Odkaz platí {hours} hodin.",
        "email_verify_unexpected": "Pokud jsi tuto změnu nevyžádal/a, ignoruj tento e-mail.",
        "email_verify_preheader": "Potvrď svou e-mailovou adresu pro nia-todo.",
        "password_invite_subject": "Tvůj přístup k nia-todo",
        "password_reset_subject": "Reset hesla nia-todo",
        "password_invite_title": "Vítej v nia-todo",
        "password_reset_title": "Reset hesla",
        "password_invite_paragraph": "Pro tvůj přístup k nia-todo byl vytvořen odkaz pro nastavení.",
        "password_reset_paragraph": "Pro tvůj účet nia-todo byl vytvořen odkaz pro heslo.",
        "password_invite_action": "Nastavit heslo",
        "password_reset_action": "Resetovat heslo",
        "password_unexpected": "Pokud jsi to nečekal/a, ignoruj tento e-mail.",
        "password_invite_preheader": "Nastav si přístup k nia-todo.",
        "password_reset_preheader": "Resetuj své heslo nia-todo.",
        "security_code": "Bezpečnostní kód",
        "login_code": "přihlašovací kód",
        "reauth_subject": "Tvůj reauth kód nia-todo",
        "twofa_subject": "Tvůj 2FA kód nia-todo",
        "code_paragraph": "Tvůj {label} je:",
        "code_expires_minutes": "Kód platí {minutes} minut.",
        "code_tip": "Tip: V nastavení si můžeš přidat také authenticator nebo passkey.",
        "code_preheader": "Tvůj nia-todo {label}: {code}",
        "smtp_test_subject": "nia-todo SMTP test",
        "smtp_test_title": "SMTP funguje",
        "smtp_test_paragraph": "Pokud vidíš tento e-mail, konfigurace SMTP v nia-todo funguje.",
        "smtp_test_detail": "Tento testovací e-mail byl odeslán přes aktuálně uloženou konfiguraci SMTP.",
        "smtp_test_preheader": "Konfigurace SMTP v nia-todo funguje.",
    },
    "fr": {
        "auto_sent": "Cet e-mail a été envoyé automatiquement par nia-todo.",
        "button_fallback": "Si le bouton ne fonctionne pas, copie ce lien :",
        "link_fallback": "Si le lien ne fonctionne pas, copie cette adresse :",
        "greeting": "Bonjour {name},",
        "greeting_default": "toi",
        "tagline": "Tes tâches. Clairement organisées.",
        "system_mail": "E-mail système",
        "unexpected": "Si tu n’attendais pas cet e-mail, tu peux l’ignorer.",
        "project_share_subject": "Partage de projet : {project_name}",
        "project_share_title": "Projet partagé avec toi",
        "project_share_paragraph": "{inviter_name} a partagé le projet « {project_name} » avec toi.",
        "project_share_action": "Voir l’invitation",
        "project_share_detail": "Tu peux accepter ou refuser l’invitation dans nia-todo.",
        "project_share_preheader": "{inviter_name} a partagé un projet avec toi.",
        "email_verify_subject": "Confirme ton e-mail nia-todo",
        "email_verify_title": "Confirmer l’adresse e-mail",
        "email_verify_paragraph": "Merci de confirmer cette adresse e-mail pour ton compte nia-todo.",
        "email_verify_action": "Confirmer l’e-mail",
        "link_expires_hours": "Le lien est valable pendant {hours} heures.",
        "email_verify_unexpected": "Si tu n’as pas demandé ce changement, ignore cet e-mail.",
        "email_verify_preheader": "Confirme ton adresse e-mail pour nia-todo.",
        "password_invite_subject": "Ton accès nia-todo",
        "password_reset_subject": "Réinitialiser ton mot de passe nia-todo",
        "password_invite_title": "Bienvenue dans nia-todo",
        "password_reset_title": "Réinitialiser le mot de passe",
        "password_invite_paragraph": "Un lien de configuration a été créé pour ton accès nia-todo.",
        "password_reset_paragraph": "Un lien de mot de passe a été créé pour ton compte nia-todo.",
        "password_invite_action": "Définir le mot de passe",
        "password_reset_action": "Réinitialiser le mot de passe",
        "password_unexpected": "Si tu ne t’y attendais pas, ignore cet e-mail.",
        "password_invite_preheader": "Configure ton accès nia-todo.",
        "password_reset_preheader": "Réinitialise ton mot de passe nia-todo.",
        "security_code": "Code de sécurité",
        "login_code": "code de connexion",
        "reauth_subject": "Ton code de réauthentification nia-todo",
        "twofa_subject": "Ton code 2FA nia-todo",
        "code_paragraph": "Ton {label} est :",
        "code_expires_minutes": "Le code est valable pendant {minutes} minutes.",
        "code_tip": "Astuce : tu peux aussi ajouter un authenticator ou une passkey dans les paramètres.",
        "code_preheader": "Ton nia-todo {label} : {code}",
        "smtp_test_subject": "Test SMTP nia-todo",
        "smtp_test_title": "SMTP fonctionne",
        "smtp_test_paragraph": "Si tu vois cet e-mail, la configuration SMTP de nia-todo fonctionne.",
        "smtp_test_detail": "Cet e-mail de test a été envoyé avec la configuration SMTP actuellement enregistrée.",
        "smtp_test_preheader": "La configuration SMTP de nia-todo fonctionne.",
    },
    "it": {
        "auto_sent": "Questa e-mail è stata inviata automaticamente da nia-todo.",
        "button_fallback": "Se il pulsante non funziona, copia questo link:",
        "link_fallback": "Se il link non funziona, copia questo indirizzo:",
        "greeting": "Ciao {name},",
        "greeting_default": "lì",
        "tagline": "Le tue attività. Organizzate chiaramente.",
        "system_mail": "E-mail di sistema",
        "unexpected": "Se non ti aspettavi questa e-mail, puoi ignorarla.",
        "project_share_subject": "Condivisione progetto: {project_name}",
        "project_share_title": "Progetto condiviso con te",
        "project_share_paragraph": "{inviter_name} ha condiviso con te il progetto “{project_name}”.",
        "project_share_action": "Vedi invito",
        "project_share_detail": "Puoi accettare o rifiutare l’invito in nia-todo.",
        "project_share_preheader": "{inviter_name} ha condiviso un progetto con te.",
        "email_verify_subject": "Conferma la tua e-mail nia-todo",
        "email_verify_title": "Conferma indirizzo e-mail",
        "email_verify_paragraph": "Conferma questo indirizzo e-mail per il tuo account nia-todo.",
        "email_verify_action": "Conferma e-mail",
        "link_expires_hours": "Il link è valido per {hours} ore.",
        "email_verify_unexpected": "Se non hai richiesto questa modifica, ignora questa e-mail.",
        "email_verify_preheader": "Conferma il tuo indirizzo e-mail per nia-todo.",
        "password_invite_subject": "Il tuo accesso a nia-todo",
        "password_reset_subject": "Reimposta la password nia-todo",
        "password_invite_title": "Benvenuto in nia-todo",
        "password_reset_title": "Reimposta password",
        "password_invite_paragraph": "È stato creato un link di configurazione per il tuo accesso a nia-todo.",
        "password_reset_paragraph": "È stato creato un link password per il tuo account nia-todo.",
        "password_invite_action": "Imposta password",
        "password_reset_action": "Reimposta password",
        "password_unexpected": "Se non te lo aspettavi, ignora questa e-mail.",
        "password_invite_preheader": "Configura il tuo accesso a nia-todo.",
        "password_reset_preheader": "Reimposta la tua password nia-todo.",
        "security_code": "Codice di sicurezza",
        "login_code": "codice di accesso",
        "reauth_subject": "Il tuo codice di riautenticazione nia-todo",
        "twofa_subject": "Il tuo codice 2FA nia-todo",
        "code_paragraph": "Il tuo {label} è:",
        "code_expires_minutes": "Il codice è valido per {minutes} minuti.",
        "code_tip": "Suggerimento: nelle impostazioni puoi aggiungere anche un authenticator o una passkey.",
        "code_preheader": "Il tuo nia-todo {label}: {code}",
        "smtp_test_subject": "Test SMTP nia-todo",
        "smtp_test_title": "SMTP funziona",
        "smtp_test_paragraph": "Se vedi questa e-mail, la configurazione SMTP di nia-todo funziona.",
        "smtp_test_detail": "Questa e-mail di test è stata inviata usando la configurazione SMTP attualmente salvata.",
        "smtp_test_preheader": "La configurazione SMTP di nia-todo funziona.",
    },
    "nl": {
        "auto_sent": "Deze e-mail is automatisch verzonden door nia-todo.",
        "button_fallback": "Als de knop niet werkt, kopieer dan deze link:",
        "link_fallback": "Als de link niet werkt, kopieer dan dit adres:",
        "greeting": "Hoi {name},",
        "greeting_default": "daar",
        "tagline": "Je taken. Helder georganiseerd.",
        "system_mail": "Systeem-e-mail",
        "unexpected": "Als je deze e-mail niet verwachtte, kun je hem negeren.",
        "project_share_subject": "Project delen: {project_name}",
        "project_share_title": "Project met je gedeeld",
        "project_share_paragraph": "{inviter_name} heeft het project “{project_name}” met je gedeeld.",
        "project_share_action": "Uitnodiging bekijken",
        "project_share_detail": "Je kunt de uitnodiging in nia-todo accepteren of weigeren.",
        "project_share_preheader": "{inviter_name} heeft een project met je gedeeld.",
        "email_verify_subject": "Bevestig je nia-todo e-mail",
        "email_verify_title": "E-mailadres bevestigen",
        "email_verify_paragraph": "Bevestig dit e-mailadres voor je nia-todo-account.",
        "email_verify_action": "E-mail bevestigen",
        "link_expires_hours": "De link is {hours} uur geldig.",
        "email_verify_unexpected": "Als je deze wijziging niet hebt aangevraagd, negeer deze e-mail dan.",
        "email_verify_preheader": "Bevestig je e-mailadres voor nia-todo.",
        "password_invite_subject": "Je nia-todo toegang",
        "password_reset_subject": "Je nia-todo wachtwoord resetten",
        "password_invite_title": "Welkom bij nia-todo",
        "password_reset_title": "Wachtwoord resetten",
        "password_invite_paragraph": "Er is een instellink gemaakt voor je nia-todo toegang.",
        "password_reset_paragraph": "Er is een wachtwoordlink gemaakt voor je nia-todo-account.",
        "password_invite_action": "Wachtwoord instellen",
        "password_reset_action": "Wachtwoord resetten",
        "password_unexpected": "Als je dit niet verwachtte, negeer deze e-mail dan.",
        "password_invite_preheader": "Stel je nia-todo toegang in.",
        "password_reset_preheader": "Reset je nia-todo wachtwoord.",
        "security_code": "Beveiligingscode",
        "login_code": "inlogcode",
        "reauth_subject": "Je nia-todo reauth-code",
        "twofa_subject": "Je nia-todo 2FA-code",
        "code_paragraph": "Je {label} is:",
        "code_expires_minutes": "De code is {minutes} minuten geldig.",
        "code_tip": "Tip: Je kunt in de instellingen ook een authenticator of passkey toevoegen.",
        "code_preheader": "Je nia-todo {label}: {code}",
        "smtp_test_subject": "nia-todo SMTP-test",
        "smtp_test_title": "SMTP werkt",
        "smtp_test_paragraph": "Als je deze e-mail ziet, werkt de SMTP-configuratie van nia-todo.",
        "smtp_test_detail": "Deze test-e-mail is verzonden met de momenteel opgeslagen SMTP-configuratie.",
        "smtp_test_preheader": "De SMTP-configuratie van nia-todo werkt.",
    },
    "pl": {
        "auto_sent": "Ten e-mail został wysłany automatycznie przez nia-todo.",
        "button_fallback": "Jeśli przycisk nie działa, skopiuj ten link:",
        "link_fallback": "Jeśli link nie działa, skopiuj ten adres:",
        "greeting": "Cześć {name},",
        "greeting_default": "tam",
        "tagline": "Twoje zadania. Jasno uporządkowane.",
        "system_mail": "E-mail systemowy",
        "unexpected": "Jeśli nie spodziewałeś/spodziewałaś się tego e-maila, możesz go zignorować.",
        "project_share_subject": "Udostępnienie projektu: {project_name}",
        "project_share_title": "Projekt został Ci udostępniony",
        "project_share_paragraph": "{inviter_name} udostępnił(a) Ci projekt „{project_name}”.",
        "project_share_action": "Zobacz zaproszenie",
        "project_share_detail": "Możesz zaakceptować lub odrzucić zaproszenie w nia-todo.",
        "project_share_preheader": "{inviter_name} udostępnił(a) Ci projekt.",
        "email_verify_subject": "Potwierdź e-mail nia-todo",
        "email_verify_title": "Potwierdź adres e-mail",
        "email_verify_paragraph": "Potwierdź ten adres e-mail dla swojego konta nia-todo.",
        "email_verify_action": "Potwierdź e-mail",
        "link_expires_hours": "Link jest ważny przez {hours} godzin.",
        "email_verify_unexpected": "Jeśli nie prosiłeś/prosiłaś o tę zmianę, zignoruj ten e-mail.",
        "email_verify_preheader": "Potwierdź swój adres e-mail dla nia-todo.",
        "password_invite_subject": "Twój dostęp do nia-todo",
        "password_reset_subject": "Zresetuj hasło nia-todo",
        "password_invite_title": "Witamy w nia-todo",
        "password_reset_title": "Reset hasła",
        "password_invite_paragraph": "Utworzono link konfiguracyjny do Twojego dostępu do nia-todo.",
        "password_reset_paragraph": "Utworzono link hasła dla Twojego konta nia-todo.",
        "password_invite_action": "Ustaw hasło",
        "password_reset_action": "Zresetuj hasło",
        "password_unexpected": "Jeśli się tego nie spodziewałeś/spodziewałaś, zignoruj ten e-mail.",
        "password_invite_preheader": "Skonfiguruj swój dostęp do nia-todo.",
        "password_reset_preheader": "Zresetuj swoje hasło nia-todo.",
        "security_code": "Kod bezpieczeństwa",
        "login_code": "kod logowania",
        "reauth_subject": "Twój kod reauth nia-todo",
        "twofa_subject": "Twój kod 2FA nia-todo",
        "code_paragraph": "Twój {label} to:",
        "code_expires_minutes": "Kod jest ważny przez {minutes} minut.",
        "code_tip": "Wskazówka: w ustawieniach możesz też dodać authenticator lub passkey.",
        "code_preheader": "Twój nia-todo {label}: {code}",
        "smtp_test_subject": "Test SMTP nia-todo",
        "smtp_test_title": "SMTP działa",
        "smtp_test_paragraph": "Jeśli widzisz ten e-mail, konfiguracja SMTP nia-todo działa.",
        "smtp_test_detail": "Ten e-mail testowy został wysłany z użyciem aktualnie zapisanej konfiguracji SMTP.",
        "smtp_test_preheader": "Konfiguracja SMTP nia-todo działa.",
    },
    "pt-BR": {
        "auto_sent": "Este e-mail foi enviado automaticamente pelo nia-todo.",
        "button_fallback": "Se o botão não funcionar, copie este link:",
        "link_fallback": "Se o link não funcionar, copie este endereço:",
        "greeting": "Olá {name},",
        "greeting_default": "aí",
        "tagline": "Suas tarefas. Claramente organizadas.",
        "system_mail": "E-mail do sistema",
        "unexpected": "Se você não esperava este e-mail, pode ignorá-lo.",
        "project_share_subject": "Compartilhamento de projeto: {project_name}",
        "project_share_title": "Projeto compartilhado com você",
        "project_share_paragraph": "{inviter_name} compartilhou o projeto “{project_name}” com você.",
        "project_share_action": "Ver convite",
        "project_share_detail": "Você pode aceitar ou recusar o convite no nia-todo.",
        "project_share_preheader": "{inviter_name} compartilhou um projeto com você.",
        "email_verify_subject": "Confirme seu e-mail do nia-todo",
        "email_verify_title": "Confirmar endereço de e-mail",
        "email_verify_paragraph": "Confirme este endereço de e-mail para sua conta nia-todo.",
        "email_verify_action": "Confirmar e-mail",
        "link_expires_hours": "O link é válido por {hours} horas.",
        "email_verify_unexpected": "Se você não solicitou esta alteração, ignore este e-mail.",
        "email_verify_preheader": "Confirme seu endereço de e-mail para o nia-todo.",
        "password_invite_subject": "Seu acesso ao nia-todo",
        "password_reset_subject": "Redefinir sua senha do nia-todo",
        "password_invite_title": "Bem-vindo ao nia-todo",
        "password_reset_title": "Redefinir senha",
        "password_invite_paragraph": "Um link de configuração foi criado para seu acesso ao nia-todo.",
        "password_reset_paragraph": "Um link de senha foi criado para sua conta nia-todo.",
        "password_invite_action": "Definir senha",
        "password_reset_action": "Redefinir senha",
        "password_unexpected": "Se você não esperava isso, ignore este e-mail.",
        "password_invite_preheader": "Configure seu acesso ao nia-todo.",
        "password_reset_preheader": "Redefina sua senha do nia-todo.",
        "security_code": "Código de segurança",
        "login_code": "código de login",
        "reauth_subject": "Seu código de reautenticação do nia-todo",
        "twofa_subject": "Seu código 2FA do nia-todo",
        "code_paragraph": "Seu {label} é:",
        "code_expires_minutes": "O código é válido por {minutes} minutos.",
        "code_tip": "Dica: você também pode adicionar um authenticator ou passkey nas configurações.",
        "code_preheader": "Seu nia-todo {label}: {code}",
        "smtp_test_subject": "Teste SMTP do nia-todo",
        "smtp_test_title": "SMTP funciona",
        "smtp_test_paragraph": "Se você consegue ver este e-mail, a configuração SMTP do nia-todo funciona.",
        "smtp_test_detail": "Este e-mail de teste foi enviado usando a configuração SMTP atualmente salva.",
        "smtp_test_preheader": "A configuração SMTP do nia-todo funciona.",
    },
    "ru": {
        "auto_sent": "Это письмо было автоматически отправлено nia-todo.",
        "button_fallback": "Если кнопка не работает, скопируйте эту ссылку:",
        "link_fallback": "Если ссылка не работает, скопируйте этот адрес:",
        "greeting": "Здравствуйте, {name},",
        "greeting_default": "пользователь",
        "tagline": "Ваши задачи. Чётко организованы.",
        "system_mail": "Системное письмо",
        "unexpected": "Если вы не ожидали это письмо, его можно проигнорировать.",
        "project_share_subject": "Доступ к проекту: {project_name}",
        "project_share_title": "С вами поделились проектом",
        "project_share_paragraph": "{inviter_name} поделился(-ась) с вами проектом «{project_name}».",
        "project_share_action": "Посмотреть приглашение",
        "project_share_detail": "Вы можете принять или отклонить приглашение в nia-todo.",
        "project_share_preheader": "{inviter_name} поделился(-ась) с вами проектом.",
        "email_verify_subject": "Подтвердите e-mail для nia-todo",
        "email_verify_title": "Подтверждение e-mail адреса",
        "email_verify_paragraph": "Подтвердите этот e-mail адрес для вашей учётной записи nia-todo.",
        "email_verify_action": "Подтвердить e-mail",
        "link_expires_hours": "Ссылка действительна {hours} часов.",
        "email_verify_unexpected": "Если вы не запрашивали это изменение, проигнорируйте это письмо.",
        "email_verify_preheader": "Подтвердите ваш e-mail адрес для nia-todo.",
        "password_invite_subject": "Ваш доступ к nia-todo",
        "password_reset_subject": "Сброс пароля nia-todo",
        "password_invite_title": "Добро пожаловать в nia-todo",
        "password_reset_title": "Сброс пароля",
        "password_invite_paragraph": "Для вашего доступа к nia-todo создана ссылка настройки.",
        "password_reset_paragraph": "Для вашей учётной записи nia-todo создана ссылка для пароля.",
        "password_invite_action": "Задать пароль",
        "password_reset_action": "Сбросить пароль",
        "password_unexpected": "Если вы этого не ожидали, проигнорируйте это письмо.",
        "password_invite_preheader": "Настройте доступ к nia-todo.",
        "password_reset_preheader": "Сбросьте пароль nia-todo.",
        "security_code": "Код безопасности",
        "login_code": "код входа",
        "reauth_subject": "Ваш reauth-код nia-todo",
        "twofa_subject": "Ваш 2FA-код nia-todo",
        "code_paragraph": "Ваш {label}:",
        "code_expires_minutes": "Код действителен {minutes} минут.",
        "code_tip": "Совет: в настройках также можно добавить authenticator или passkey.",
        "code_preheader": "Ваш nia-todo {label}: {code}",
        "smtp_test_subject": "SMTP-тест nia-todo",
        "smtp_test_title": "SMTP работает",
        "smtp_test_paragraph": "Если вы видите это письмо, конфигурация SMTP в nia-todo работает.",
        "smtp_test_detail": "Это тестовое письмо было отправлено с текущей сохранённой конфигурацией SMTP.",
        "smtp_test_preheader": "Конфигурация SMTP в nia-todo работает.",
    },
    "sv": {
        "auto_sent": "Det här e-postmeddelandet skickades automatiskt av nia-todo.",
        "button_fallback": "Om knappen inte fungerar, kopiera den här länken:",
        "link_fallback": "Om länken inte fungerar, kopiera den här adressen:",
        "greeting": "Hej {name},",
        "greeting_default": "där",
        "tagline": "Dina uppgifter. Tydligt organiserade.",
        "system_mail": "Systemmeddelande",
        "unexpected": "Om du inte väntade dig det här e-postmeddelandet kan du ignorera det.",
        "project_share_subject": "Projektdelning: {project_name}",
        "project_share_title": "Projekt delat med dig",
        "project_share_paragraph": "{inviter_name} har delat projektet “{project_name}” med dig.",
        "project_share_action": "Visa inbjudan",
        "project_share_detail": "Du kan acceptera eller avböja inbjudan i nia-todo.",
        "project_share_preheader": "{inviter_name} har delat ett projekt med dig.",
        "email_verify_subject": "Bekräfta din nia-todo e-post",
        "email_verify_title": "Bekräfta e-postadress",
        "email_verify_paragraph": "Bekräfta den här e-postadressen för ditt nia-todo-konto.",
        "email_verify_action": "Bekräfta e-post",
        "link_expires_hours": "Länken är giltig i {hours} timmar.",
        "email_verify_unexpected": "Om du inte begärde den här ändringen, ignorera detta e-postmeddelande.",
        "email_verify_preheader": "Bekräfta din e-postadress för nia-todo.",
        "password_invite_subject": "Din nia-todo åtkomst",
        "password_reset_subject": "Återställ ditt nia-todo lösenord",
        "password_invite_title": "Välkommen till nia-todo",
        "password_reset_title": "Återställ lösenord",
        "password_invite_paragraph": "En installationslänk har skapats för din nia-todo åtkomst.",
        "password_reset_paragraph": "En lösenordslänk har skapats för ditt nia-todo-konto.",
        "password_invite_action": "Ange lösenord",
        "password_reset_action": "Återställ lösenord",
        "password_unexpected": "Om du inte väntade dig detta, ignorera detta e-postmeddelande.",
        "password_invite_preheader": "Konfigurera din nia-todo åtkomst.",
        "password_reset_preheader": "Återställ ditt nia-todo lösenord.",
        "security_code": "Säkerhetskod",
        "login_code": "inloggningskod",
        "reauth_subject": "Din nia-todo reauth-kod",
        "twofa_subject": "Din nia-todo 2FA-kod",
        "code_paragraph": "Din {label} är:",
        "code_expires_minutes": "Koden är giltig i {minutes} minuter.",
        "code_tip": "Tips: Du kan också lägga till en authenticator eller passkey i inställningarna.",
        "code_preheader": "Din nia-todo {label}: {code}",
        "smtp_test_subject": "nia-todo SMTP-test",
        "smtp_test_title": "SMTP fungerar",
        "smtp_test_paragraph": "Om du ser det här e-postmeddelandet fungerar nia-todos SMTP-konfiguration.",
        "smtp_test_detail": "Det här testmeddelandet skickades med den sparade SMTP-konfigurationen.",
        "smtp_test_preheader": "nia-todos SMTP-konfiguration fungerar.",
    },
    "es": {
        "auto_sent": "Este e-mail fue enviado automáticamente por nia-todo.",
        "button_fallback": "Si el botón no funciona, copia este enlace:",
        "link_fallback": "Si el enlace no funciona, copia esta dirección:",
        "greeting": "Hola {name},",
        "greeting_default": "ahí",
        "tagline": "Tus tareas. Claramente organizadas.",
        "system_mail": "E-mail del sistema",
        "unexpected": "Si no esperabas este e-mail, puedes ignorarlo.",
        "project_share_subject": "Proyecto compartido: {project_name}",
        "project_share_title": "Proyecto compartido contigo",
        "project_share_paragraph": "{inviter_name} compartió el proyecto “{project_name}” contigo.",
        "project_share_action": "Ver invitación",
        "project_share_detail": "Puedes aceptar o rechazar la invitación en nia-todo.",
        "project_share_preheader": "{inviter_name} compartió un proyecto contigo.",
        "email_verify_subject": "Confirma tu e-mail de nia-todo",
        "email_verify_title": "Confirmar dirección de e-mail",
        "email_verify_paragraph": "Confirma esta dirección de e-mail para tu cuenta de nia-todo.",
        "email_verify_action": "Confirmar e-mail",
        "link_expires_hours": "El enlace es válido durante {hours} horas.",
        "email_verify_unexpected": "Si no solicitaste este cambio, ignora este e-mail.",
        "email_verify_preheader": "Confirma tu dirección de e-mail para nia-todo.",
        "password_invite_subject": "Tu acceso a nia-todo",
        "password_reset_subject": "Restablecer tu contraseña de nia-todo",
        "password_invite_title": "Bienvenido a nia-todo",
        "password_reset_title": "Restablecer contraseña",
        "password_invite_paragraph": "Se creó un enlace de configuración para tu acceso a nia-todo.",
        "password_reset_paragraph": "Se creó un enlace de contraseña para tu cuenta de nia-todo.",
        "password_invite_action": "Establecer contraseña",
        "password_reset_action": "Restablecer contraseña",
        "password_unexpected": "Si no esperabas esto, ignora este e-mail.",
        "password_invite_preheader": "Configura tu acceso a nia-todo.",
        "password_reset_preheader": "Restablece tu contraseña de nia-todo.",
        "security_code": "código de seguridad",
        "login_code": "código de inicio de sesión",
        "reauth_subject": "Tu código de reautenticación de nia-todo",
        "twofa_subject": "Tu código 2FA de nia-todo",
        "code_paragraph": "Tu {label} es:",
        "code_expires_minutes": "El código es válido durante {minutes} minutos.",
        "code_tip": "Consejo: también puedes añadir un authenticator o una passkey en los ajustes.",
        "code_preheader": "Tu nia-todo {label}: {code}",
        "smtp_test_subject": "Prueba SMTP de nia-todo",
        "smtp_test_title": "SMTP funciona",
        "smtp_test_paragraph": "Si puedes ver este e-mail, la configuración SMTP de nia-todo funciona.",
        "smtp_test_detail": "Este e-mail de prueba fue enviado usando la configuración SMTP guardada actualmente.",
        "smtp_test_preheader": "La configuración SMTP de nia-todo funciona.",
    },
    "zh-CN": {
        "auto_sent": "此邮件由 nia-todo 自动发送。",
        "button_fallback": "如果按钮无法使用，请复制此链接：",
        "link_fallback": "如果链接无法使用，请复制此地址：",
        "greeting": "你好，{name}，",
        "greeting_default": "你好",
        "tagline": "你的任务，清晰有序。",
        "system_mail": "系统邮件",
        "unexpected": "如果你没有预期收到这封邮件，可以忽略它。",
        "project_share_subject": "项目共享：{project_name}",
        "project_share_title": "有人与你共享了项目",
        "project_share_paragraph": "{inviter_name} 与你共享了项目“{project_name}”。",
        "project_share_action": "查看邀请",
        "project_share_detail": "你可以在 nia-todo 中接受或拒绝该邀请。",
        "project_share_preheader": "{inviter_name} 与你共享了一个项目。",
        "email_verify_subject": "确认你的 nia-todo 邮箱",
        "email_verify_title": "确认邮箱地址",
        "email_verify_paragraph": "请确认此邮箱地址用于你的 nia-todo 账户。",
        "email_verify_action": "确认邮箱",
        "link_expires_hours": "此链接有效期为 {hours} 小时。",
        "email_verify_unexpected": "如果你没有请求此更改，请忽略此邮件。",
        "email_verify_preheader": "确认你的 nia-todo 邮箱地址。",
        "password_invite_subject": "你的 nia-todo 访问权限",
        "password_reset_subject": "重置你的 nia-todo 密码",
        "password_invite_title": "欢迎使用 nia-todo",
        "password_reset_title": "重置密码",
        "password_invite_paragraph": "已为你的 nia-todo 访问权限创建设置链接。",
        "password_reset_paragraph": "已为你的 nia-todo 账户创建密码链接。",
        "password_invite_action": "设置密码",
        "password_reset_action": "重置密码",
        "password_unexpected": "如果你没有预期此操作，请忽略此邮件。",
        "password_invite_preheader": "设置你的 nia-todo 访问权限。",
        "password_reset_preheader": "重置你的 nia-todo 密码。",
        "security_code": "安全代码",
        "login_code": "登录代码",
        "reauth_subject": "你的 nia-todo 重新认证代码",
        "twofa_subject": "你的 nia-todo 2FA 代码",
        "code_paragraph": "你的 {label} 是：",
        "code_expires_minutes": "此代码有效期为 {minutes} 分钟。",
        "code_tip": "提示：你也可以在设置中添加 authenticator 或 passkey。",
        "code_preheader": "你的 nia-todo {label}：{code}",
        "smtp_test_subject": "nia-todo SMTP 测试",
        "smtp_test_title": "SMTP 正常工作",
        "smtp_test_paragraph": "如果你能看到这封邮件，说明 nia-todo 的 SMTP 配置正常工作。",
        "smtp_test_detail": "此测试邮件使用当前保存的 SMTP 配置发送。",
        "smtp_test_preheader": "nia-todo 的 SMTP 配置正常工作。",
    },

}


def _language(value: str | None) -> str:
    language = str(value or "").strip()
    lower = language.lower()
    if language == "zh-CN" or lower in {"zh-cn", "zh-hans"}:
        return "zh-CN"
    if lower == "pt-br":
        return "pt-BR"
    language = lower
    if language in EMAIL_COPY:
        return language
    return "en"


def _copy(language: str | None) -> dict[str, str]:
    return EMAIL_COPY[_language(language)]



def _clean_subject(value: str) -> str:
    """Return a single-line, reasonably sized e-mail subject."""
    cleaned = " ".join(str(value or "").split())
    if len(cleaned) <= MAX_SUBJECT_LENGTH:
        return cleaned
    return cleaned[: MAX_SUBJECT_LENGTH - 1].rstrip() + "..."


def _logo_src() -> str:
    """Prefer CID logos because most mail clients block remote images and dislike data URIs."""
    return f"cid:{LOGO_CID}"


def _text_email(*, greeting: str, paragraphs: list[str], action_label: str | None = None, action_url: str | None = None, details: list[str] | None = None, inline_code: str | None = None, language: str = "de") -> str:
    parts = [greeting, *paragraphs]
    if inline_code and len(parts) > 1:
        parts[-1] = f"{parts[-1]} {inline_code}"
    if action_label and action_url:
        parts.append(f"{action_label}:\n{action_url}")
    if details:
        parts.extend(details)
    parts.append(_copy(language)["auto_sent"] if language == "de" else _copy(language)["auto_sent"])
    return "\n\n".join(part.strip() for part in parts if part and part.strip())


def _modern_button_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return f"""
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 18px;">
        <tr>
          <td class="modern-button" bgcolor="#111827" style="border-radius:14px;background:#111827;">
            <a href="{safe_url}" style="display:inline-block;padding:13px 22px;border-radius:14px;color:#ffffff;background:#111827;font-size:15px;font-weight:800;text-decoration:none;letter-spacing:.01em;">
              {safe_label} →
            </a>
          </td>
        </tr>
      </table>
    """.strip()


def _modern_fallback_link_html(link: str, *, language: str = "de") -> str:
    safe_link = escape(link)
    safe_href = escape(link, quote=True)
    return (
        f'<p class="modern-muted" style="margin:18px 0 0;color:{MUTED_COLOR};font-size:13px;line-height:1.6;">'
        f'{escape(_copy(language)["button_fallback"])}<br>'
        f'<a class="modern-link" href="{safe_href}" style="color:{LINK_COLOR};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
        '</p>'
    )


def _outlook_action_link_html(label: str, url: str) -> str:
    safe_label = escape(label)
    safe_url = escape(url, quote=True)
    return (
        '<p style="margin:28px 0 18px;font-family:Arial,sans-serif;font-size:16px;line-height:24px;font-weight:bold;">'
        f'<a href="{safe_url}" style="color:{LINK_COLOR};text-decoration:underline;font-weight:bold;">{safe_label} →</a>'
        '</p>'
    )


def _outlook_fallback_link_html(link: str, *, language: str = "de") -> str:
    safe_link = escape(link)
    safe_href = escape(link, quote=True)
    return (
        '<p style="margin:18px 0 0;font-family:Arial,sans-serif;font-size:13px;line-height:20px;color:#64748b;">'
        f'{escape(_copy(language)["link_fallback"])}<br>'
        f'<a href="{safe_href}" style="color:{LINK_COLOR};word-break:break-all;text-decoration:underline;">{safe_link}</a>'
        '</p>'
    )


def _detail_box(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        content = f'<div class="modern-detail-text" style="margin:0;color:#475569;font-size:14px;line-height:1.5;">{escape(items[0])}</div>'
    else:
        rows = "".join(
            f'<li class="modern-detail-text" style="margin:7px 0;color:#475569;font-size:14px;line-height:1.5;">{escape(item)}</li>'
            for item in items
        )
        content = f'<ul style="margin:0;padding-left:19px;">{rows}</ul>'
    return (
        '<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:24px 0 0;">'
        '<tr>'
        '<td class="modern-detail-box" style="padding:15px 17px;border:1px solid #e2e8f0;border-radius:16px;background:#f8fafc;">'
        f'{content}'
        '</td>'
        '</tr>'
        '</table>'
    )


def _modern_body_html(*, safe_name: str, paragraphs: list[str], action_label: str | None, action_url: str | None, details: list[str], inline_code: str | None = None, language: str = "de") -> str:
    body = [f'<p class="modern-text" style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#334155;">{escape(_copy(language)["greeting"].format(name=safe_name))}</p>']
    for index, paragraph in enumerate(paragraphs):
        suffix = ""
        if inline_code and index == len(paragraphs) - 1:
            suffix = f' <strong class="modern-code" style="font-weight:900;color:#0f172a;">{escape(inline_code)}</strong>'
        body.append(f'<p class="modern-text" style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#334155;">{escape(paragraph)}{suffix}</p>')
    if action_label and action_url:
        body.append(_modern_button_html(action_label, action_url))
        body.append(_modern_fallback_link_html(action_url, language=language))
    body.append(_detail_box(details))
    return "".join(body)


def _outlook_body_html(*, safe_name: str, paragraphs: list[str], action_label: str | None, action_url: str | None, details: list[str], inline_code: str | None = None, language: str = "de") -> str:
    body = [f'<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:#334155;">{escape(_copy(language)["greeting"].format(name=safe_name))}</p>']
    for index, paragraph in enumerate(paragraphs):
        suffix = ""
        if inline_code and index == len(paragraphs) - 1:
            suffix = f' <strong style="font-weight:bold;color:#0f172a;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#0f172a;mso-style-textfill-fill-alpha:100000;">{escape(inline_code)}</strong>'
        body.append(f'<p style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:#334155;">{escape(paragraph)}{suffix}</p>')
    if action_label and action_url:
        body.append(_outlook_action_link_html(action_label, action_url))
        body.append(_outlook_fallback_link_html(action_url, language=language))
    body.append(_detail_box(details))
    return "".join(body)


def _layout(*, title: str, preheader: str, modern_body_html: str, outlook_body_html: str, language: str = "de") -> str:
    safe_title = escape(title)
    safe_preheader = escape(preheader)
    logo_src = escape(_logo_src(), quote=True)
    return f"""<!doctype html>
<html lang="{_language(language)}">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>{safe_title}</title>
  <style>
    @media (prefers-color-scheme: dark) {{
      .modern-wrap {{ background:#0b1020 !important; }}
      .hero-shell {{ padding:0 !important; background:#0b1020 !important; }}
      .modern-hero {{
        background:#18213f !important;
        background-image:linear-gradient(135deg,#18213f 0%,#1e1b4b 100%) !important;
        border-radius:0 0 30px 30px !important;
        box-shadow:0 1px 0 rgba(199,210,254,.18),0 18px 42px rgba(0,0,0,.42) !important;
      }}
      .modern-body, .modern-footer {{ background:#0b1020 !important; }}
      .modern-text {{ color:#dbe4ff !important; }}
      .modern-code {{ color:#ffffff !important; }}
      .modern-muted {{ color:#a5b4fc !important; }}
      .modern-link {{ color:#c7d2fe !important; }}
      .modern-detail-box {{ background:#111a33 !important; border-color:rgba(199,210,254,.24) !important; }}
      .modern-detail-text {{ color:#dbe4ff !important; }}
      .modern-button {{ background:#1e293b !important; box-shadow:0 0 0 1px rgba(199,210,254,.22) !important; }}
      .modern-button a {{ background:#1e293b !important; color:#ffffff !important; }}
    }}
  </style>
  <!--[if mso]>
  <style type="text/css">
    table {{ border-collapse: collapse; border-spacing: 0; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }}
    td, p, a, div {{ font-family: Arial, sans-serif !important; mso-line-height-rule: exactly; }}
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:{TEXT_COLOR};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">{safe_preheader}</div>
  <!--[if mso]>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff;border-collapse:collapse;">
    <tr><td align="center" style="padding:28px 0 34px;background:#ffffff;">
      <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;border-collapse:collapse;">
        <tr><td style="padding:0;">
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" style="height:214px;v-text-anchor:top;width:640px;" arcsize="14%" stroke="f" fillcolor="#111827">
            <v:fill color="#111827"/>
            <v:textbox inset="28px,30px,28px,30px">
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;">
                <tr>
                  <td width="48" valign="middle" style="width:48px;padding:0;vertical-align:middle;"><img src="{logo_src}" width="48" height="48" alt="nia-todo" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none;"></td>
                  <td valign="middle" style="padding:0 0 0 13px;vertical-align:middle;">
                    <div style="font-family:Arial,sans-serif;font-size:18px;line-height:21px;font-weight:bold;color:#ffffff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#ffffff;mso-style-textfill-fill-alpha:100000;">{BRAND_NAME}</div>
                    <div style="font-family:Arial,sans-serif;font-size:13px;line-height:18px;color:#dbe4ff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#dbe4ff;mso-style-textfill-fill-alpha:100000;">{escape(_copy(language)["tagline"])}</div>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;"><tr><td height="30" style="height:30px;line-height:30px;font-size:0;">&nbsp;</td></tr></table>
              <div style="font-family:Arial,sans-serif;font-size:12px;line-height:16px;font-weight:bold;color:#dbe4ff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#dbe4ff;mso-style-textfill-fill-alpha:100000;">{escape(_copy(language)["system_mail"].upper())}</div>
              <table role="presentation" width="584" cellspacing="0" cellpadding="0" border="0" style="width:584px;border-collapse:collapse;"><tr><td height="10" style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr></table>
              <div style="font-family:Arial,sans-serif;font-size:32px;line-height:36px;font-weight:bold;color:#ffffff;mso-style-textfill-type:solid;mso-style-textfill-fill-color:#ffffff;mso-style-textfill-fill-alpha:100000;">{safe_title}</div>
            </v:textbox>
          </v:roundrect>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:30px 28px 24px;">
          {outlook_body_html}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;"><tr><td style="border-top:1px solid #e5e7eb;padding:16px 0 0;font-family:Arial,sans-serif;font-size:14px;line-height:22px;color:#64748b;">{escape(_copy(language)["unexpected"])}</td></tr></table>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:0 28px 32px;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">{escape(_copy(language)["auto_sent"])}</td></tr>
      </table>
    </td></tr>
  </table>
  <![endif]-->
  <!--[if !mso]><!-->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="modern-wrap" style="background:#ffffff;padding:0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;margin:0 auto;">
        <tr><td class="hero-shell" style="padding:0;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td class="modern-hero" style="padding:34px 28px 30px;background:#111827;background-image:linear-gradient(135deg,#111827 0%,#1e1b4b 100%);border-radius:0 0 30px 30px;color:#ffffff;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
                <td style="width:48px;vertical-align:middle;"><img src="{logo_src}" width="48" height="48" alt="nia-todo" style="display:block;border:0;border-radius:14px;"></td>
                <td style="padding-left:13px;vertical-align:middle;"><div style="font-size:18px;font-weight:900;letter-spacing:-.025em;color:#ffffff;line-height:1.15;">{BRAND_NAME}</div><div style="font-size:13px;color:#c7d2fe;line-height:1.35;margin-top:3px;">{escape(_copy(language)["tagline"])}</div></td>
              </tr></table>
              <div style="height:30px;line-height:30px;font-size:0;">&nbsp;</div>
              <div style="font-size:12px;color:#c7d2fe;font-weight:800;text-transform:uppercase;letter-spacing:.10em;margin-bottom:10px;">{escape(_copy(language)["system_mail"])}</div>
              <h1 style="margin:0;font-size:32px;line-height:1.08;letter-spacing:-.05em;color:#ffffff;font-weight:900;">{safe_title}</h1>
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="modern-body" style="padding:30px 28px 24px;background:#ffffff;">
          {modern_body_html}
        </td></tr>
        <tr><td class="modern-footer modern-muted" style="padding:0 28px 32px;background:#ffffff;color:#94a3b8;font-size:12px;line-height:1.5;">{escape(_copy(language)["auto_sent"])}<br>{escape(_copy(language)["unexpected"])}</td></tr>
      </table>
    </td></tr>
  </table>
  <!--<![endif]-->
</body>
</html>""".strip()


def render_system_email(
    *,
    subject: str,
    title: str,
    greeting_name: str,
    paragraphs: list[str],
    action_label: str | None = None,
    action_url: str | None = None,
    details: list[str] | None = None,
    preheader: str | None = None,
    inline_code: str | None = None,
    language: str = "de",
) -> tuple[str, str, str]:
    """Return subject, plain text and branded HTML for a nia-todo system email."""
    language = _language(language)
    copy = _copy(language)
    safe_name = greeting_name.strip() if greeting_name else copy["greeting_default"]
    greeting = copy["greeting"].format(name=safe_name)
    cleaned_subject = _clean_subject(subject)
    safe_paragraphs = [str(paragraph) for paragraph in paragraphs if str(paragraph).strip()]
    safe_details = [str(item) for item in (details or []) if str(item).strip()]
    safe_inline_code = str(inline_code).strip() if inline_code else None
    text = _text_email(greeting=greeting, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details, inline_code=safe_inline_code, language=language)
    modern_body = _modern_body_html(safe_name=safe_name, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details, inline_code=safe_inline_code, language=language)
    outlook_body = _outlook_body_html(safe_name=safe_name, paragraphs=safe_paragraphs, action_label=action_label, action_url=action_url, details=safe_details, inline_code=safe_inline_code, language=language)
    html = _layout(
        title=title,
        preheader=preheader or (safe_paragraphs[0] if safe_paragraphs else title),
        modern_body_html=modern_body,
        outlook_body_html=outlook_body,
        language=language,
    )
    return cleaned_subject, text, html


def project_share_invite_email(*, display_name: str, username: str, project_name: str, inviter_name: str, link: str, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    safe_name = display_name or username
    return render_system_email(
        subject=copy["project_share_subject"].format(project_name=project_name),
        title=copy["project_share_title"],
        greeting_name=safe_name,
        paragraphs=[copy["project_share_paragraph"].format(inviter_name=inviter_name, project_name=project_name)],
        action_label=copy["project_share_action"],
        action_url=link,
        details=[copy["project_share_detail"]],
        preheader=copy["project_share_preheader"].format(inviter_name=inviter_name),
        language=language,
    )


def email_verification_email(*, display_name: str, username: str, link: str, expires_hours: int, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    safe_name = display_name or username
    return render_system_email(
        subject=copy["email_verify_subject"],
        title=copy["email_verify_title"],
        greeting_name=safe_name,
        paragraphs=[copy["email_verify_paragraph"]],
        action_label=copy["email_verify_action"],
        action_url=link,
        details=[copy["link_expires_hours"].format(hours=expires_hours), copy["email_verify_unexpected"]],
        preheader=copy["email_verify_preheader"],
        language=language,
    )


def password_setup_email(*, display_name: str, username: str, link: str, purpose: str, expires_hours: int, language: str = "de") -> tuple[str, str, str]:
    """Return subject, text, html for invite/reset setup links."""
    copy = _copy(language)
    safe_name = display_name or username
    is_invite = purpose == "invite"
    prefix = "password_invite" if is_invite else "password_reset"
    return render_system_email(
        subject=copy[f"{prefix}_subject"],
        title=copy[f"{prefix}_title"],
        greeting_name=safe_name,
        paragraphs=[copy[f"{prefix}_paragraph"]],
        action_label=copy[f"{prefix}_action"],
        action_url=link,
        details=[copy["link_expires_hours"].format(hours=expires_hours), copy["password_unexpected"]],
        preheader=copy[f"{prefix}_preheader"],
        language=language,
    )


def two_factor_code_email(*, display_name: str, username: str, code: str, purpose: str = "login", expires_minutes: int = 10, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    safe_name = display_name or username
    is_reauth = purpose == "reauth"
    label = copy["security_code"] if is_reauth else copy["login_code"]
    return render_system_email(
        subject=copy["reauth_subject"] if is_reauth else copy["twofa_subject"],
        title=label,
        greeting_name=safe_name,
        paragraphs=[copy["code_paragraph"].format(label=label)],
        details=[copy["code_expires_minutes"].format(minutes=expires_minutes), copy["code_tip"]],
        preheader=copy["code_preheader"].format(label=label, code=code),
        inline_code=code,
        language=language,
    )


def test_email(*, to: str | None = None, language: str = "de") -> tuple[str, str, str]:
    copy = _copy(language)
    return render_system_email(
        subject=copy["smtp_test_subject"],
        title=copy["smtp_test_title"],
        greeting_name=copy["greeting_default"],
        paragraphs=[copy["smtp_test_paragraph"]],
        details=[copy["smtp_test_detail"]],
        preheader=copy["smtp_test_preheader"],
        language=language,
    )
