PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,channel TEXT NOT NULL,message TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,
  UNIQUE(source,channel,message,revision,kind));

CREATE TABLE IF NOT EXISTS messages(source TEXT NOT NULL,channel TEXT NOT NULL,message TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL,payload TEXT NOT NULL,
  PRIMARY KEY(source,channel,message));

CREATE TABLE IF NOT EXISTS mentions(id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,channel TEXT NOT NULL,message TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,sender_key TEXT NOT NULL,sender TEXT NOT NULL,at INTEGER NOT NULL,bot INTEGER NOT NULL,active INTEGER NOT NULL,
  UNIQUE(source,channel,message,chain,address));
CREATE INDEX IF NOT EXISTS mentions_token ON mentions(chain,address,active,bot,at,id);

CREATE TABLE IF NOT EXISTS tokens(chain TEXT NOT NULL,address TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,blocked INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL DEFAULT '{}',last_call INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chain,address));
CREATE INDEX IF NOT EXISTS tokens_last_call ON tokens(last_call);

CREATE TABLE IF NOT EXISTS claims(chain TEXT NOT NULL,address TEXT NOT NULL,owner INTEGER,version INTEGER NOT NULL,at INTEGER,active INTEGER NOT NULL,
  PRIMARY KEY(chain,address),
  FOREIGN KEY(owner) REFERENCES mentions(id),
  FOREIGN KEY(chain,address) REFERENCES tokens(chain,address));
CREATE INDEX IF NOT EXISTS claims_address ON claims(address);

CREATE TABLE IF NOT EXISTS evidence(id INTEGER PRIMARY KEY,chain TEXT NOT NULL,address TEXT NOT NULL,claim_version INTEGER NOT NULL,kind TEXT NOT NULL,provider TEXT NOT NULL,at INTEGER NOT NULL,mc REAL,price REAL,payload TEXT NOT NULL,accepted INTEGER NOT NULL,reason TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,received_at INTEGER NOT NULL,
  UNIQUE(chain,address,claim_version,kind,provider,at,mc,price),
  FOREIGN KEY(chain,address) REFERENCES tokens(chain,address));
CREATE INDEX IF NOT EXISTS evidence_claim ON evidence(chain,address,claim_version,kind,accepted,revoked,mc);

CREATE TABLE IF NOT EXISTS results(chain TEXT NOT NULL,address TEXT NOT NULL,claim_version INTEGER NOT NULL,baseline_id INTEGER,formal_peak_id INTEGER,reference_peak_id INTEGER,low_id INTEGER,status TEXT NOT NULL,
  PRIMARY KEY(chain,address),
  FOREIGN KEY(chain,address) REFERENCES tokens(chain,address),
  FOREIGN KEY(baseline_id) REFERENCES evidence(id),
  FOREIGN KEY(formal_peak_id) REFERENCES evidence(id),
  FOREIGN KEY(reference_peak_id) REFERENCES evidence(id),
  FOREIGN KEY(low_id) REFERENCES evidence(id));

CREATE TABLE IF NOT EXISTS quotes(chain TEXT NOT NULL,address TEXT NOT NULL,provider TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,generation INTEGER NOT NULL,
  PRIMARY KEY(chain,address,provider));

CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,lane TEXT NOT NULL,chain TEXT NOT NULL,address TEXT NOT NULL,claim_version INTEGER NOT NULL,payload TEXT NOT NULL DEFAULT '{}',state TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 10,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER,last_error TEXT,updated_at INTEGER NOT NULL,
  UNIQUE(lane,chain,address,claim_version),
  FOREIGN KEY(chain,address) REFERENCES tokens(chain,address));
CREATE INDEX IF NOT EXISTS jobs_schedule ON jobs(lane,state,due,priority,id);

CREATE TABLE IF NOT EXISTS projections(name TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS price_results(chain TEXT NOT NULL,address TEXT NOT NULL,claim_version INTEGER NOT NULL,baseline TEXT,peak TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(chain,address),FOREIGN KEY(chain,address) REFERENCES tokens(chain,address));

CREATE TABLE IF NOT EXISTS diagnostics(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,category TEXT NOT NULL,token TEXT,detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS diagnostics_trace ON diagnostics(category,token,id);
