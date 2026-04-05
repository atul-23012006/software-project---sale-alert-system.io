CREATE OR REPLACE PROCEDURE check_alerts AS
    CURSOR c_tracking IS
        SELECT t.user_id, t.product_id, t.target_price
        FROM tracking t;

    v_price NUMBER;
BEGIN
    FOR rec IN c_tracking LOOP

        -- Get latest price
        SELECT price INTO v_price
        FROM (
            SELECT price
            FROM price_history
            WHERE product_id = rec.product_id
            ORDER BY timestamp DESC
        )
        WHERE ROWNUM = 1;

        -- If price <= target → create alert
        IF v_price <= rec.target_price THEN
            INSERT INTO alerts (
                alert_id, user_id, product_id, price, created_at, sent
            )
            VALUES (
                alert_seq.NEXTVAL,
                rec.user_id,
                rec.product_id,
                v_price,
                SYSDATE,
                0
            );
        END IF;

    END LOOP;

    COMMIT;
END;
/