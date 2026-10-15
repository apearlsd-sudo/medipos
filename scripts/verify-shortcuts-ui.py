"""Task 57 UI smoke — POS keyboard shortcuts (F1 help, F2 focus, F4 charge,
F6 park, F8 clear-cart confirm, Ctrl+Enter hint, expired-add guard) + return
dialog restock dispositions. Run: python3 scripts/verify-shortcuts-ui.py"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
FAILS = []

def ok(l): print(f"PASS: {l}")
def bad(l):
    print(f"FAIL: {l}"); FAILS.append(l)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(BASE, wait_until="networkidle")
    page.fill('input[name="username"], #username, input[type="text"]', "admin")
    page.fill('input[type="password"]', "admin123")
    page.click("button[type=submit]")
    page.wait_for_timeout(1800)

    # --- POS ----------------------------------------------------------------
    page.click('text="POS Terminal"')
    page.wait_for_timeout(2200)

    # start a shift if none is open (F4 gating)
    if page.get_by_text("No active shift").count() > 0:
        page.locator('button:has-text("Start Shift")').first.click()
        page.wait_for_timeout(800)
        page.locator('button:has-text("Start Shift")').last.click()
        page.wait_for_timeout(1200)

    search = page.locator('input[aria-label="Product search"]')
    if search.count() > 0:
        ok("POS search box present")
    else:
        bad("POS search box missing"); print("\n".join(errors)); browser.close(); sys.exit(1)

    def charge_enabled():
        b = page.locator('button:has-text("Charge")')
        return b.count() > 0 and not b.first.is_disabled()

    def add_product(term):
        """Click the first stocked product card matching the term (the catalog has
        same-name duplicates across branches — search-Enter may hit a 0-stock one)."""
        cards = page.locator(f'button:has-text("{term}")').filter(has_not_text="Out of stock")
        if cards.count() > 0:
            cards.first.click()
            page.wait_for_timeout(700)

    # expired batch guard: find the expired fixture card and try it
    exp_card = page.locator('button:has-text("RSS Restock EXPIRED")').filter(has_not_text="Out of stock")
    if exp_card.count() > 0:
        exp_card.first.click()
        page.wait_for_timeout(700)
        if page.get_by_text("Expired stock").count() > 0:
            ok("expired product add is blocked with a clear toast")
        else:
            bad("expired product was added — guard missing")
        page.mouse.click(400, 300)  # dismiss any overlay
    else:
        print("note: no expired fixture present (guard not exercised)")
    # fall back to a sellable product
    added = False
    for term in ["RSS Restock OK", "Aspirin", "Amoxicillin", "Cetirizine", "Omeprazole", "Artemether"]:
        add_product(term)
        if charge_enabled():
            added = True
            break
    if added:
        ok("sellable product added to cart")
    else:
        bad("could not add any sellable product"); browser.close(); sys.exit(1)

    # F1 → shortcuts help overlay
    page.keyboard.press("F1")
    page.wait_for_timeout(600)
    if page.get_by_text("Keyboard shortcuts").count() > 0 and page.get_by_text("Charge — open checkout").count() > 0:
        ok("F1 opens the shortcuts help with the F4 row")
    else:
        bad("F1 help overlay missing")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    # '?' outside an input also opens help
    page.keyboard.press("?")
    page.wait_for_timeout(500)
    if page.get_by_text("Keyboard shortcuts").count() > 0:
        ok("'?' opens help outside inputs")
    else:
        bad("'?' help missing")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)

    # F2 focuses the search box
    page.keyboard.press("F2")
    page.wait_for_timeout(300)
    focused = page.evaluate("() => document.activeElement && document.activeElement.getAttribute('aria-label')")
    if focused == "Product search":
        ok("F2 focuses the product search box")
    else:
        bad(f"F2 focus wrong: {focused}")

    # F4 opens checkout with the Ctrl+Enter hint
    page.keyboard.press("F4")
    page.wait_for_timeout(800)
    if page.get_by_text("Complete Sale").count() > 0 and page.get_by_text("to confirm").count() > 0:
        ok("F4 opens checkout; Ctrl+Enter hint shown")
    else:
        bad("F4 checkout or hint missing")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)

    # F6 opens the park-sale dialog (textarea #hold-note)
    page.keyboard.press("F6")
    page.wait_for_timeout(700)
    if page.locator('#hold-note').count() > 0 and page.get_by_text("Park this sale").count() > 0:
        ok("F6 opens the park-sale dialog")
    else:
        bad("F6 park dialog missing")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)

    # F8 opens clear-cart confirm; confirm empties the cart
    page.keyboard.press("F8")
    page.wait_for_timeout(700)
    if page.get_by_text("Clear the cart?").count() > 0:
        ok("F8 opens the clear-cart confirmation")
        page.get_by_role("button", name="Clear cart").click()
        page.wait_for_timeout(600)
        if not charge_enabled():
            ok("confirm clears the cart")
        else:
            bad("cart not cleared after confirm")
    else:
        bad("F8 confirm missing")

    # shortcut hints on the buttons
    if page.locator('button[title="Keyboard: F4"]').count() > 0 and page.locator('button[title="Keyboard: F6"]').count() > 0:
        ok("button F-key hints present")
    else:
        bad("button F-key hints missing")

    # --- Return dialog: dispositions ---------------------------------------
    page.click('text="Sales & Invoices"')
    page.wait_for_timeout(2000)
    ret_btn = page.locator('button[aria-label="Process return"]').first
    if ret_btn.count() > 0:
        ret_btn.click()
        page.wait_for_timeout(1500)
        if page.get_by_text("Restock to").count() > 0:
            ok("return dialog shows Restock-to column")
        else:
            bad("Restock-to column missing")
        # default reason damaged/expired → quarantine pre-selected
        if page.get_by_text("Quarantine").count() > 0:
            ok("quarantine default selected for damaged reason")
        else:
            bad("quarantine default missing")
        # switch reason → sellable default appears (row selects are disabled
        # until a qty is entered, so target the Reason label's own combobox)
        reason_trigger = page.locator('label:has-text("Reason") + button[role="combobox"]').first
        if reason_trigger.count() == 0:
            reason_trigger = page.locator('button[role="combobox"]:near(label:has-text("Reason"))').first
        reason_trigger.click()
        page.wait_for_timeout(400)
        page.get_by_role("option", name="Customer changed mind").click()
        page.wait_for_timeout(500)
        if page.get_by_text("Shelf (sellable)").count() > 0:
            ok("changed_mind reason flips default to sellable")
        else:
            bad("sellable default after reason change missing")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    else:
        print("SKIP: no returnable sales on the list")

    if errors:
        bad(f"page errors: {errors[:3]}")

    browser.close()

print("---")
if FAILS:
    print(f"{len(FAILS)} FAILURES"); sys.exit(1)
print("ALL SHORTCUT/RESTOCK UI TESTS GREEN")
