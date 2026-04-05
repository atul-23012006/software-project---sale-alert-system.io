-- USERS
CREATE TABLE users (
    user_id NUMBER PRIMARY KEY,
    phone_number VARCHAR2(15) UNIQUE
);

-- PRODUCTS
CREATE TABLE products (
    product_id NUMBER PRIMARY KEY,
    name VARCHAR2(300),
    url VARCHAR2(1000) UNIQUE
);

-- TRACKING
CREATE TABLE tracking (
    tracking_id NUMBER PRIMARY KEY,
    user_id NUMBER,
    product_id NUMBER,
    target_price NUMBER,

    CONSTRAINT fk_tracking_user FOREIGN KEY (user_id)
        REFERENCES users(user_id),

    CONSTRAINT fk_tracking_product FOREIGN KEY (product_id)
        REFERENCES products(product_id),

    CONSTRAINT unique_tracking UNIQUE (user_id, product_id)
);

-- PRICE HISTORY
CREATE TABLE price_history (
    history_id NUMBER PRIMARY KEY,
    product_id NUMBER,
    price NUMBER,
    timestamp DATE,

    CONSTRAINT fk_price_product FOREIGN KEY (product_id)
        REFERENCES products(product_id)
);

-- ALERTS
CREATE TABLE alerts (
    alert_id NUMBER PRIMARY KEY,
    user_id NUMBER,
    product_id NUMBER,
    price NUMBER,
    created_at DATE,
    sent NUMBER DEFAULT 0,

    CONSTRAINT fk_alert_user FOREIGN KEY (user_id)
        REFERENCES users(user_id),

    CONSTRAINT fk_alert_product FOREIGN KEY (product_id)
        REFERENCES products(product_id)
);