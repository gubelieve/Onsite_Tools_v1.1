"""Capture DNAC - Selenium screenshots of Catalyst Center pages (login via XPath from CSV)."""
import os
import shutil
from datetime import datetime
from time import sleep

from ..core import csvutil
from ..core.logutil import now_hms, safe_name
from ..core.paths import BASE_DIR, SCREENSHOTS_DIR

TOOL = {
    "id": "capture_dnac",
    "name": "Capture DNAC (Screenshots)",
    "category": "Catalyst Center / SD-WAN",
    "order": 63,
    "description": "Open each URL from the CSV in Chrome (Selenium), log in using the XPaths given, and save a "
                   "screenshot to screenshots/. Requires Google Chrome on the server machine.",
    "fields": [
        {"name": "csv_file", "label": "Capture list (CSV)", "type": "file", "accept": ".csv", "required": True,
         "template": "dnac_capture_template.csv",
         "help": "Columns: url, username, password, xpath_user, xpath_pwd, xpath_login, description, session_type "
                 "(login|direct)"},
        {"name": "page_wait", "label": "Page load wait (s)", "type": "number", "default": 15, "min": 1, "max": 120,
         "width": "half"},
        {"name": "headless", "label": "Headless Chrome", "type": "checkbox", "default": False, "width": "half",
         "help": "Run Chrome without a visible window."},
    ],
    "columns": ["Stage", "Status", "Message", "Time"],
    "runs": [{"id": "run", "label": "Start Capture"}],
}


def _driver(ctx, headless):
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service

    opts = webdriver.ChromeOptions()
    opts.add_argument("--start-maximized")
    opts.add_argument("ignore-certificate-errors")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    if headless:
        opts.add_argument("--headless=new")
        opts.add_argument("--window-size=1920,1080")
    driver_path = None
    local = [os.path.join(BASE_DIR, "chromedriver.exe"), os.path.join(BASE_DIR, "chromedriver")]
    for p in local:
        if os.path.exists(p):
            driver_path = p
            ctx.log(f"Using local ChromeDriver: {p}")
            break
    if not driver_path:
        try:
            from webdriver_manager.chrome import ChromeDriverManager

            driver_path = ChromeDriverManager().install()
        except Exception as e1:
            ctx.log(f"WebDriver Manager failed: {e1}", "WARNING")
            try:
                cache = os.path.join(os.path.expanduser("~"), ".wdm")
                if os.path.exists(cache):
                    shutil.rmtree(cache)
                from webdriver_manager.chrome import ChromeDriverManager

                driver_path = ChromeDriverManager().install()
            except Exception as e2:
                raise RuntimeError("ChromeDriver not available. Install Google Chrome, make sure the internet is "
                                   f"reachable, or put chromedriver.exe in {BASE_DIR}. ({e2})")
    if driver_path:
        return webdriver.Chrome(service=Service(driver_path), options=opts)
    return webdriver.Chrome(options=opts)


def run(ctx, params):
    ctx.set_columns(TOOL["columns"])

    def emit(stage, status, message):
        ctx.add_row({"Stage": stage, "Status": status, "Message": message, "Time": now_hms()})

    try:
        from selenium.common.exceptions import NoSuchElementException, TimeoutException
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
    except ImportError:
        ctx.error("selenium is not installed. Run:  .venv\\Scripts\\pip install selenium webdriver-manager")
        return
    fields, rows = csvutil.read_csv(params["csv_file"])
    rows = [r for r in rows if r.get("url")][:1000]
    emit("Setup", "Success", f"Loaded {len(rows)} rows from CSV")
    if not rows:
        return
    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
    wait_s = int(params.get("page_wait") or 15)
    emit("Setup", "Processing", "Initializing Chrome WebDriver...")
    try:
        driver = _driver(ctx, bool(params.get("headless")))
    except Exception as e:
        emit("Setup", "Error", f"Failed to initialize WebDriver: {e}")
        ctx.log(str(e), "ERROR")
        return
    emit("Setup", "Success", "Chrome WebDriver initialized successfully")
    ctx.progress(0, len(rows))
    shots = 0
    try:
        for i, row in enumerate(rows, start=1):
            if ctx.stop_requested:
                emit("Stopped", "Info", "Capture process stopped by user")
                break
            emit("Processing", "Info", f"Processing row {i}/{len(rows)}")
            url = row["url"]
            desc = row.get("description") or "dnac"
            try:
                if (row.get("session_type") or "login").lower() == "login":
                    emit("Login", "Processing", f"Accessing {url}")
                    driver.get(url)
                    sleep(wait_s)
                    wait = WebDriverWait(driver, 30)
                    try:
                        user_el = wait.until(EC.element_to_be_clickable((By.XPATH, row["xpath_user"])))
                        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", user_el)
                        sleep(0.5)
                        user_el.clear()
                        user_el.send_keys(row.get("username", ""))
                        pwd_el = wait.until(EC.element_to_be_clickable((By.XPATH, row["xpath_pwd"])))
                        pwd_el.send_keys(row.get("password", ""))
                        btn = wait.until(EC.element_to_be_clickable((By.XPATH, row["xpath_login"])))
                        try:
                            btn.click()
                        except Exception:
                            driver.execute_script("arguments[0].click();", btn)
                        emit("Login", "Processing", "Login button clicked")
                    except (NoSuchElementException, TimeoutException) as e:
                        emit("Login", "Error", f"Could not find or interact with login fields: {e}")
                        ctx.step()
                        continue
                    sleep(3)
                    emit("Login", "Success", f"Login completed for {desc}")
                else:
                    driver.get(url)
                    sleep(3)
                sleep(3)
                path = os.path.join(SCREENSHOTS_DIR, f"{safe_name(desc)}_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.png")
                driver.save_screenshot(path)
                shots += 1
                ctx.artifact(os.path.basename(path), path)
                emit("Capture", "Success", f"Screenshot saved: {path}")
                sleep(2)
            except Exception as e:
                emit("Processing", "Error", f"Error processing row {i}: {e}")
                ctx.log(f"Error processing row {i}: {e}", "ERROR")
            ctx.step()
    finally:
        try:
            driver.quit()
            emit("Cleanup", "Success", "WebDriver closed")
        except Exception as e:
            ctx.log(f"Error closing WebDriver: {e}", "WARNING")
    ctx.summary(f"{shots} screenshot(s) saved to {SCREENSHOTS_DIR}")
    ctx.info("DNAC capture process finished.")
